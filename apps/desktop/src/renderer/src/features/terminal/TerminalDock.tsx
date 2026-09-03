import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Plus, RotateCcw, X } from 'lucide-react'
import type { RpcResults } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { ContextMenu, type MenuAnchor } from '../../shell/ContextMenu'
import { TerminalA11y } from './TerminalA11y'
import { TerminalPane } from './TerminalPane'
import {
  activateTerminalTab,
  closeTerminalTab,
  openTerminalTab,
  subscribeTerminalDock,
  terminalDockState,
} from './terminal-dock'
import { subscribeTerminalRequests, type TerminalTabRequest } from './terminal-requests'

type Detection = RpcResults['providers.detect'][number]

/** Launchable tabs: a plain OS shell plus whichever coding CLIs are installed. */
interface TabPreset {
  id: string
  label: string
  /** First command written into the shell after spawn. */
  command?: string
  /** Only offered when this driver kind is detected on the machine. */
  kind?: Detection['kind']
}

const SHELL_PRESET: TabPreset = { id: 'shell', label: 'Ari Terminal' }

const PRESETS: TabPreset[] = [
  SHELL_PRESET,
  { id: 'claude', label: 'Claude Code', command: 'claude', kind: 'claude' },
  { id: 'codex', label: 'Codex CLI', command: 'codex', kind: 'codex' },
]

/**
 * Terminal rail (M24.2): the machine's own shell docked to the right of the
 * transcript, the way T3 Code keeps one. Every tab is a real pty from the OS —
 * PowerShell, zsh or bash, spawned in the active project's folder, not an
 * emulated command box — so `git`, `pnpm` and the agent CLIs behave exactly as
 * they do in a standalone terminal.
 *
 * Tabs live in the module-level dock store, so closing the rail parks the
 * shells instead of killing them; only the tab's × does that.
 */
export function TerminalDock({ cwd, onClose }: { cwd?: string; onClose?: () => void }) {
  const { tabs, activeId } = useSyncExternalStore(subscribeTerminalDock, terminalDockState)
  const [failed, setFailed] = useState<string | null>(null)
  const [resolvedCwd, setResolvedCwd] = useState<string | null>(cwd ?? null)
  const [launcherAnchor, setLauncherAnchor] = useState<MenuAnchor | null>(null)
  const [installedKinds, setInstalledKinds] = useState<Set<string>>(new Set())
  const [cwdAttempt, setCwdAttempt] = useState(0)
  // `terminal.create` rejections used to leave a blank blinking cursor; each
  // tab now keeps its failure so the rail can name it and offer a retry.
  const [errorByTab, setErrorByTab] = useState<Record<string, string>>({})
  const [retryNonce, setRetryNonce] = useState<Record<string, number>>({})

  useEffect(() => {
    setResolvedCwd(cwd ?? null)
  }, [cwd])

  // The renderer is sandboxed — without a project the working directory has to
  // come from the main process. `cwdAttempt` is what Retry bumps: the failed
  // state leaves `resolvedCwd` null, so it alone can't re-trigger this.
  useEffect(() => {
    if (resolvedCwd !== null) return
    void rpc
      .invoke('app.info')
      .then((info) => setResolvedCwd(info.homeDir))
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
  }, [resolvedCwd, cwdAttempt])

  // Agent presets are only offered for CLIs actually installed; the plain
  // shell preset is always available.
  useEffect(() => {
    void rpc
      .invoke('providers.detect')
      .then((detections) => {
        setInstalledKinds(
          new Set(detections.filter((d) => d.binaryPath !== null).map((d) => d.kind)),
        )
      })
      .catch(() => undefined)
  }, [])

  const spawnPreset = useCallback(
    (preset: TabPreset) => {
      if (resolvedCwd === null) return
      openTerminalTab({ title: preset.label, cwd: resolvedCwd, command: preset.command })
    },
    [resolvedCwd],
  )

  // Run-script requests (M21.3) and CLI sign-in (M22.1) open their own tab.
  useEffect(
    () =>
      subscribeTerminalRequests((request: TerminalTabRequest) => {
        openTerminalTab({ title: request.title, cwd: request.cwd, command: request.command })
      }),
    [],
  )

  // Opening the rail is a request for a shell, so an empty dock spawns one.
  // Emptying it by hand stays empty — the once-per-mount latch is what keeps
  // closing the last tab from instantly respawning it.
  const autoOpened = useRef(false)
  useEffect(() => {
    if (autoOpened.current || resolvedCwd === null || tabs.length > 0) return
    autoOpened.current = true
    openTerminalTab({ title: SHELL_PRESET.label, cwd: resolvedCwd })
  }, [resolvedCwd, tabs.length])

  const closeTab = useCallback((id: string) => {
    void rpc.invoke('terminal.kill', { id }).catch(() => undefined)
    closeTerminalTab(id)
    setErrorByTab((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const handlePaneError = useCallback(
    (id: string) => (message: string) => {
      setErrorByTab((prev) => (prev[id] === message ? prev : { ...prev, [id]: message }))
    },
    [],
  )

  // Clearing the error and bumping the nonce remounts just that pane, which
  // re-runs `terminal.create` (idempotent per id: a live pty is re-adopted).
  const retryTab = useCallback((id: string) => {
    setErrorByTab((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setRetryNonce((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))
  }, [])

  const availablePresets = PRESETS.filter((p) => p.kind === undefined || installedKinds.has(p.kind))
  const activeTitle = tabs.find((tab) => tab.id === activeId)?.title ?? 'none'
  const activeError = activeId !== null ? (errorByTab[activeId] ?? null) : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <div
          role="group"
          aria-label="Terminals"
          className="ari-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const active = tab.id === activeId
            return (
              <span
                key={tab.id}
                className={`group flex h-6 shrink-0 items-center gap-0.5 rounded-md pl-2 pr-1 transition-colors ${
                  active ? 'bg-accent-subtle text-accent' : 'text-fg-subtle hover:bg-surface-2'
                }`}
              >
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => activateTerminalTab(tab.id)}
                  className="max-w-32 truncate font-mono text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => closeTab(tab.id)}
                  className="flex h-4 w-4 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  <X size={9} />
                </button>
              </span>
            )
          })}
        </div>
        <RailButton
          label="New terminal"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setLauncherAnchor({ x: rect.left, y: rect.bottom + 4 })
          }}
        >
          <Plus size={14} aria-hidden />
        </RailButton>
        {onClose ? (
          <RailButton label="Close terminal panel" onClick={onClose}>
            <X size={13} aria-hidden />
          </RailButton>
        ) : null}
      </div>

      {launcherAnchor !== null ? (
        <ContextMenu
          anchor={launcherAnchor}
          label="New terminal"
          items={availablePresets.map((preset) => ({
            id: preset.id,
            label:
              preset.command !== undefined ? `${preset.label} (${preset.command})` : preset.label,
            onSelect: () => spawnPreset(preset),
          }))}
          onClose={() => setLauncherAnchor(null)}
        />
      ) : null}

      <TerminalA11y title={activeTitle} />

      {activeError !== null && activeId !== null ? (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-danger-subtle bg-danger-subtle px-3 py-1.5 text-xs text-danger"
        >
          <span className="min-w-0 flex-1 truncate" title={activeError}>
            Terminal failed to start: {activeError}
          </span>
          <button
            type="button"
            onClick={() => retryTab(activeId)}
            className="flex shrink-0 items-center gap-1 rounded-md border border-danger px-2 py-0.5 text-2xs transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <RotateCcw size={10} aria-hidden /> Retry
          </button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {failed !== null ? (
          <EmptyRail message={`Terminal could not start: ${failed}`} tone="danger">
            <RailAction
              label="Retry"
              icon={<RotateCcw size={12} />}
              onClick={() => {
                setFailed(null)
                setCwdAttempt((n) => n + 1)
              }}
            />
          </EmptyRail>
        ) : tabs.length === 0 ? (
          <EmptyRail message="No terminal open.">
            <RailAction
              label="Open a terminal"
              icon={<Plus size={12} />}
              onClick={() => spawnPreset(SHELL_PRESET)}
            />
          </EmptyRail>
        ) : (
          tabs.map((tab) => {
            const active = tab.id === activeId
            // Background tabs stay mounted so their output keeps flowing, and
            // keep a layout box so xterm's fit addon still measures them.
            return (
              <div
                key={`${tab.id}:${retryNonce[tab.id] ?? 0}`}
                aria-hidden={!active}
                className={`absolute inset-0 ${active ? '' : 'invisible'}`}
              >
                <TerminalPane
                  terminalId={tab.id}
                  cwd={tab.cwd}
                  initialCommand={tab.command}
                  active={active}
                  onError={handlePaneError(tab.id)}
                />
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function RailButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      {children}
    </button>
  )
}

function EmptyRail({
  message,
  tone,
  children,
}: {
  message: string
  tone?: 'danger'
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
      <p className={`text-center text-xs ${tone === 'danger' ? 'text-danger' : 'text-fg-subtle'}`}>
        {message}
      </p>
      {children}
    </div>
  )
}

function RailAction({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      {icon} {label}
    </button>
  )
}
