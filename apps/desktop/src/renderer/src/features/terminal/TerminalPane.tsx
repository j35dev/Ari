import { useEffect, useMemo, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { findTerminalTab } from './terminal-dock'
import { useToolSessionClient } from './tool-session-client'
import { createTerminalSessionAdapter } from './terminal-session-adapter'
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
  attachOnly = false,
  active,
  onError,
}: {
  terminalId: string
  cwd: string | null
  /** First command written into the shell after spawn (presets, run scripts). */
  initialCommand?: string
  /** Attach to a host-created setup terminal; never starts or repeats its login command. */
  attachOnly?: boolean
  /** Focused pane: steals xterm focus without re-creating anything. */
  active: boolean
  /** Receives the `terminal.create` rejection message so the dock can offer a retry. */
  onError?: (message: string) => void
}) {
  const owner = findTerminalTab(terminalId)?.owner
  const scopeKey = owner?.kind === 'remote' ? JSON.stringify([owner.machineId, owner.sessionId])
    : terminalId.startsWith('rterm_') ? '["invalid"]' : undefined
  const sessionClient = useToolSessionClient(scopeKey)
  const rpc = useMemo(() => createTerminalSessionAdapter(sessionClient),
    [sessionClient, sessionClient.authorizationEpoch, sessionClient.availability])
  const remote = sessionClient.scope.kind === 'remote' || terminalId.startsWith('rterm_')
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // Kept out of the spawn effect's deps: reporting a failure must not respawn the pty.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    if (remote && rpc.readOnly) {
      onErrorRef.current?.('Reconnect this terminal to its owning machine.')
      return
    }
    if (remote && initialCommand) {
      onErrorRef.current?.('Launch presets are unavailable remotely. Use the host shell directly.')
      return
    }
    if (cwd === null && !remote) return
    const host = hostRef.current
    if (!host) return

    // xterm sizes the character cell by assigning `ctx.font` on an offscreen
    // canvas, and canvas cannot resolve CSS custom properties: a `var(...)`
    // font family is rejected outright, leaving the grid measured against
    // 10px sans-serif while the rows render in the real font. Resolve it here.
    const fontFamily = readToken('--ari-font-mono', FALLBACK_FONT)
    const fontSize = FONT_SIZE

    const term = new Terminal({
      fontFamily,
      fontSize,
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
    const fitAndResize = (): void => {
      try {
        fit.fit()
        void rpc
          .invoke('terminal.resize', { id: terminalId, cols: term.cols, rows: term.rows })
          .catch(() => undefined)
      } catch {
        // A hidden pane can have a zero-size box; its resize observer retries.
      }
    }
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
    const warmFont = (family: string, size: number): void => {
      try {
        void document.fonts
          .load(`${size}px ${family}`)
          .then(() => {
            if (
              termRef.current !== term ||
              term.options.fontFamily !== family ||
              term.options.fontSize !== size ||
              family === FALLBACK_FONT
            )
              return
            term.options.fontFamily = FALLBACK_FONT
            term.options.fontFamily = family
            fitAndResize()
          })
          .catch(() => undefined)
      } catch {
        // no FontFaceSet (jsdom): the first measurement stands
      }
    }
    warmFont(fontFamily, fontSize)

    // Update font metrics in place so choosing a new face never restarts a shell.
    const fontObserver = new MutationObserver(() => {
      const family = readToken('--ari-font-mono', FALLBACK_FONT)
      const size = FONT_SIZE
      if (term.options.fontFamily === family && term.options.fontSize === size) return
      term.options.fontFamily = family
      term.options.fontSize = size
      fitAndResize()
      warmFont(family, size)
    })
    fontObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })

    // A rejected create used to vanish into `.catch(() => undefined)`, leaving
    // a blank xterm with a blinking cursor and no way to tell it had failed.
    if (!attachOnly)
      void rpc
        .invoke('terminal.create', { id: terminalId, cwd: cwd ?? '.' })
        .then(async () => {
          if (!remote && initialCommand !== undefined && initialCommand.length > 0) {
            await rpc.invoke('terminal.write', { id: terminalId, data: `${initialCommand}\r` })
          }
          if (remote) await rpc.invoke('terminal.resize', { id: terminalId, cols: term.cols, rows: term.rows })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          term.writeln(`\r\n[Terminal failed to start: ${message}]`)
          onErrorRef.current?.(message)
        })

    const dataSub = rpc.subscribe('terminal.data', { id: terminalId }, (payload) => {
      const frame = payload as { id: string; data: string; reset?: boolean; exited?: boolean; error?: string }
      if (frame.id !== terminalId) return
      if (frame.reset) term.reset()
      if (frame.error || frame.exited) {
        term.options.disableStdin = true
        const message = frame.error ?? 'The host shell exited.'
        term.writeln(`\r\n[${message}]`)
        onErrorRef.current?.(message)
      }
      term.write(frame.data)
    })
    const inputSub = term.onData((data) => {
      void rpc.invoke('terminal.write', { id: terminalId, data }).catch((error: unknown) => {
        if (!remote) return
        term.options.disableStdin = true
        const message = error instanceof Error ? error.message : 'The terminal action could not be confirmed.'
        term.writeln(`\r\n[${message}]`)
        onErrorRef.current?.(message)
      })
    })

    const observer = new ResizeObserver(fitAndResize)
    observer.observe(host)
    void rpc
      .invoke('terminal.resize', { id: terminalId, cols: term.cols, rows: term.rows })
      .catch(() => undefined)

    return () => {
      termRef.current = null
      observer.disconnect()
      fontObserver.disconnect()
      dataSub()
      inputSub.dispose()
      disposeClipboard()
      term.dispose()
    }
    // initialCommand is consumed once at spawn; excluding it from these deps
    // keeps the pty alive across re-renders.
  }, [terminalId, cwd, attachOnly, rpc, remote])

  // Focus follows pane activation without re-creating anything.
  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  return (
    <div className="h-full min-h-0 w-full overflow-hidden">
      <div ref={hostRef} className="h-full min-h-0 w-full overflow-hidden px-3 py-2" />
    </div>
  )
}
