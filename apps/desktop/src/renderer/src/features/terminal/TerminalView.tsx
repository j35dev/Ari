import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { rpc } from '../../lib/rpc'

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

let terminalSeq = 0

/**
 * Interactive terminal pane backed by a pty session in the main process.
 * Theme colors are sampled from the active design tokens at mount.
 */
export function TerminalView({ cwd }: { cwd: string }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const id = `term_${++terminalSeq}_${Math.random().toString(36).slice(2, 8)}`
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
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    try {
      fit.fit()
    } catch {
      // fitting before layout can fail; the resize observer retries
    }

    void rpc.invoke('terminal.create', { id, cwd })

    const dataSub = rpc.subscribe('terminal.data', { id }, (payload) => {
      const frame = payload as { id: string; data: string }
      if (frame.id === id) term.write(frame.data)
    })
    const inputSub = term.onData((data) => {
      void rpc.invoke('terminal.write', { id, data })
    })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        rpc.invoke('terminal.resize', { id, cols: term.cols, rows: term.rows }).catch(
          () => undefined,
        )
      } catch {
        // zero-size layout moments are fine
      }
    })
    observer.observe(host)
    void rpc.invoke('terminal.resize', { id, cols: term.cols, rows: term.rows }).catch(
      () => undefined,
    )

    return () => {
      observer.disconnect()
      dataSub()
      inputSub.dispose()
      void rpc.invoke('terminal.kill', { id }).catch(() => undefined)
      term.dispose()
    }
  }, [cwd])

  return <div ref={hostRef} className="h-full w-full bg-bg p-1" />
}
