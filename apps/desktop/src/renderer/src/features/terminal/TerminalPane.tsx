import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { rpc } from '../../lib/rpc'

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

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
}: {
  terminalId: string
  cwd: string | null
  /** First command written into the shell after spawn (presets, run scripts). */
  initialCommand?: string
  /** Focused pane: steals xterm focus without re-creating anything. */
  active: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (cwd === null) return
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "var(--ari-font-mono, 'Geist Mono Variable'), monospace",
      fontSize: 12,
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
    try {
      fit.fit()
    } catch {
      // fitting before layout can fail; the resize observer retries
    }

    void rpc.invoke('terminal.create', { id: terminalId, cwd }).then(() => {
      if (initialCommand !== undefined && initialCommand.length > 0) {
        return rpc.invoke('terminal.write', { id: terminalId, data: `${initialCommand}\r` })
      }
      return undefined
    }).catch(() => undefined)

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
      term.dispose()
    }
    // initialCommand is consumed once at spawn; excluding it from these deps
    // keeps the pty alive across re-renders.
  }, [terminalId, cwd])

  // Focus follows pane activation without re-creating anything.
  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  return <div ref={hostRef} className="h-full w-full p-1" />
}
