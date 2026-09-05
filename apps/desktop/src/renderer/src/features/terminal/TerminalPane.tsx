import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { rpc } from '../../lib/rpc'
import { bindTerminalClipboard } from './terminal-clipboard'

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

/** Used when the mono token is missing, and as the round trip that re-measures. */
const FALLBACK_FONT = "'Cascadia Code', ui-monospace, monospace"
const FONT_SIZE = 13
/** xterm defaults to 1.0, which reads as one solid block of text. */
const LINE_HEIGHT = 1.3

/**
 * One live xterm bound to a pty session in the main process. `terminal.create`
 * is idempotent in the main process (an existing session is reused and its
 * scrollback replays through the subscription), so remounts never lose output.
 */
export function TerminalPane({
  terminalId,
  cwd,
  initialCommand,
  active,
  onError,
}: {
  terminalId: string
  cwd: string | null
  /** First command written into the shell after spawn (presets, run scripts). */
  initialCommand?: string
  /** Focused pane: steals xterm focus without re-creating anything. */
  active: boolean
  /** Receives the `terminal.create` rejection message so the dock can offer a retry. */
  onError?: (message: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // Kept out of the spawn effect's deps: reporting a failure must not respawn the pty.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    if (cwd === null) return
    const host = hostRef.current
    if (!host) return

    // xterm sizes the character cell by assigning `ctx.font` on an offscreen
    // canvas, and canvas cannot resolve CSS custom properties: a `var(...)`
    // font family is rejected outright, leaving the grid measured against
    // 10px sans-serif while the rows render in the real font. Resolve it here.
    const fontFamily = readToken('--ari-font-mono', FALLBACK_FONT)

    const term = new Terminal({
      fontFamily,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      fontWeight: 400,
      fontWeightBold: 600,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: readToken('--ari-bg', '#0b0b0e'),
        foreground: readToken('--ari-fg', '#e6e6ea'),
        cursor: readToken('--ari-accent', '#7c6cf0'),
        selectionBackground: readToken('--ari-accent-subtle', '#333'),
        black: readToken('--ari-surface-2', '#222'),
        green: readToken('--ari-success', '#4ade80'),
        red: readToken('--ari-danger', '#f87171'),
        yellow: readToken('--ari-warning', '#facc15'),
        blue: readToken('--ari-info', '#60a5fa'),
      },
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    const disposeClipboard = bindTerminalClipboard(term, (message) => {
      term.writeln(`\r\n[${message}]`)
    })
    try {
      fit.fit()
    } catch {
      // fitting before layout can fail; the resize observer retries
    }

    // The bundled mono webfont may still be loading when a rail opens, and the
    // cell is only measured once. Only an option *change* re-runs that
    // measurement, hence the round trip through the fallback family.
    try {
      void document.fonts
        .load(`${FONT_SIZE}px ${fontFamily}`)
        .then(() => {
          if (termRef.current !== term || fontFamily === FALLBACK_FONT) return
          term.options.fontFamily = FALLBACK_FONT
          term.options.fontFamily = fontFamily
          fit.fit()
        })
        .catch(() => undefined)
    } catch {
      // no FontFaceSet (jsdom): the first measurement stands
    }

    // A rejected create used to vanish into `.catch(() => undefined)`, leaving
    // a blank xterm with a blinking cursor and no way to tell it had failed.
    void rpc.invoke('terminal.create', { id: terminalId, cwd }).then(() => {
      if (initialCommand !== undefined && initialCommand.length > 0) {
        return rpc.invoke('terminal.write', { id: terminalId, data: `${initialCommand}\r` })
      }
      return undefined
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      term.writeln(`\r\n[Terminal failed to start: ${message}]`)
      onErrorRef.current?.(message)
    })

    const dataSub = rpc.subscribe('terminal.data', { id: terminalId }, (payload) => {
      const frame = payload as { id: string; data: string }
      if (frame.id === terminalId) term.write(frame.data)
    })
    const inputSub = term.onData((data) => {
      void rpc.invoke('terminal.write', { id: terminalId, data }).catch(() => undefined)
    })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        rpc.invoke('terminal.resize', { id: terminalId, cols: term.cols, rows: term.rows }).catch(
          () => undefined,
        )
      } catch {
        // zero-size layout moments are fine
      }
    })
    observer.observe(host)
    void rpc.invoke('terminal.resize', { id: terminalId, cols: term.cols, rows: term.rows }).catch(
      () => undefined,
    )

    return () => {
      termRef.current = null
      observer.disconnect()
      dataSub()
      inputSub.dispose()
      disposeClipboard()
      term.dispose()
    }
    // initialCommand is consumed once at spawn; excluding it from these deps
    // keeps the pty alive across re-renders.
  }, [terminalId, cwd])

  // Focus follows pane activation without re-creating anything.
  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  return <div ref={hostRef} className="h-full w-full px-3 py-2" />
}
