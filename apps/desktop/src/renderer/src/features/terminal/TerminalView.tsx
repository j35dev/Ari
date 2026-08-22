import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Plus, RotateCcw, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { rpc } from '../../lib/rpc'

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

let terminalSeq = 0

function makeTerminalId(): string {
  return `term_${++terminalSeq}_${Math.random().toString(36).slice(2, 8)}`
}

function defaultShellLabel(): string {
  if (navigator.userAgent.toLowerCase().includes('windows')) return 'pwsh'
  if (navigator.userAgent.toLowerCase().includes('mac')) return 'zsh'
  return 'sh'
}

interface TerminalTab {
  id: string
  title: string
}

/**
 * Multi-terminal pane: a tab strip over independent pty sessions. Tabs stay
 * mounted while hidden so background output keeps flowing and viewports are
 * preserved; ptys die only when their tab is closed.
 */
export function TerminalView({ cwd }: { cwd?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  const [resolvedCwd, setResolvedCwd] = useState<string | null>(cwd ?? null)
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    setResolvedCwd(cwd ?? null)
  }, [cwd])

  // The renderer is sandboxed — the shell's working directory comes from the
  // main process. Fall back to the user's home directory.
  useEffect(() => {
    if (resolvedCwd !== null) return
    void rpc
      .invoke('app.info')
      .then((info) => setResolvedCwd(info.homeDir))
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
  }, [resolvedCwd])

  const addTab = useCallback(() => {
    const id = makeTerminalId()
    const base = defaultShellLabel()
    setTabs((prev) => {
      const same = prev.filter((t) => t.title.startsWith(base)).length
      const title = same === 0 ? base : `${base} ${same + 1}`
      return [...prev, { id, title }]
    })
    setActiveId(id)
  }, [])

  // Open the first tab automatically once the working directory is known.
  useEffect(() => {
    if (resolvedCwd !== null && tabs.length === 0) addTab()
  }, [resolvedCwd, tabs.length, addTab])

  const closeTab = useCallback((id: string) => {
    void rpc.invoke('terminal.kill', { id }).catch(() => undefined)
    setTabs((prev) => {
      const index = prev.findIndex((t) => t.id === id)
      const next = prev.filter((t) => t.id !== id)
      setActiveId((current) =>
        current === id ? (next[Math.min(index, next.length - 1)]?.id ?? null) : current,
      )
      return next
    })
  }, [])

  if (failed !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg">
        <p className="max-w-sm text-center text-sm text-danger">Terminal could not start: {failed}</p>
        <button
          type="button"
          onClick={() => {
            setFailed(null)
            setTabs([])
            setActiveId(null)
          }}
          className="flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <RotateCcw size={12} /> Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div
        role="tablist"
        aria-label="Terminals"
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-surface-0 px-1.5 py-1"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeId
          return (
            <div
              key={tab.id}
              role="presentation"
              className={`group flex shrink-0 items-center gap-1 rounded-md pl-2 pr-1 text-xs transition-colors ${
                isActive
                  ? 'bg-surface-2 text-fg'
                  : 'text-fg-subtle hover:bg-surface-1 hover:text-fg-muted'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveId(tab.id)}
                className="py-1 font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                {tab.title}
              </button>
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={() => closeTab(tab.id)}
                className="rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-surface-3 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
        <button
          type="button"
          aria-label="New terminal"
          onClick={addTab}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <Plus size={13} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="text-xs text-fg-subtle">No terminals open.</p>
            <button
              type="button"
              onClick={addTab}
              className="flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              <Plus size={12} /> New terminal
            </button>
          </div>
        ) : (
          tabs.map((tab) => (
            <div key={tab.id} className={tab.id === activeId ? 'h-full w-full' : 'hidden'}>
              <TerminalPane terminalId={tab.id} cwd={resolvedCwd} active={tab.id === activeId} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** One live xterm bound to a pty session in the main process. */
function TerminalPane({
  terminalId,
  cwd,
  active,
}: {
  terminalId: string
  cwd: string | null
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

    // Idempotent in the main process: an existing session is reused and its
    // scrollback replays through the subscription below.
    void rpc.invoke('terminal.create', { id: terminalId, cwd }).catch(() => undefined)

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
  }, [terminalId, cwd])

  // Focus follows tab activation without re-creating anything.
  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  return <div ref={hostRef} aria-hidden={!active} className="h-full w-full p-1" />
}
