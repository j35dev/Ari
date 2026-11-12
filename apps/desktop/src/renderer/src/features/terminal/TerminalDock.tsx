import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { FolderPlus, Plus, RotateCcw, X } from 'lucide-react'
import type { RpcResults } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import {
  cx,
  iconButton,
  outlineButton,
  rowAction,
  tab as tabClass,
  tabSelected,
} from '../../lib/recipes'
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
 * `cwd` is that project folder, and it is the only place a shell can start:
 * `terminal.create` jails its working directory against the registered project
 * roots. A null `cwd` therefore means there is nowhere to run — no project at
 * all, or a legacy Unfiled session whose workspace is the home directory —
 * and the rail says so rather than opening a shell the main process refuses.
 *
 * Tabs live in the module-level dock store, so closing the rail parks the
 * shells instead of killing them; only the tab's × does that. The rail has no
 * close button of its own: the panel's tab row, drawn by the host, closes it.
 */
export function TerminalDock({
  cwd,
  onAddProject,
  paneTerminalIds,
}: {
  cwd: string | null
  /** Opens the folder picker, so a railless project can still be added. */
  onAddProject?: () => void
  /**
   * Accepted for the host's sake and never drawn: the docked panel's tab row
   * owns the close button, so the rail does not repeat it.
   */
  onClose?: () => void
  /** Tabs already shown in a split pane — the rail hides them so a pty is never mounted twice. */
  paneTerminalIds?: ReadonlySet<string>
}) {
  const dock = useSyncExternalStore(subscribeTerminalDock, terminalDockState)
  const paneHosted = paneTerminalIds ?? new Set<string>()
  const tabs = dock.tabs.filter((tab) => !paneHosted.has(tab.id))
  const activeId =
    dock.activeId !== null && paneHosted.has(dock.activeId) ? (tabs[0]?.id ?? null) : dock.activeId
  const [launcherAnchor, setLauncherAnchor] = useState<MenuAnchor | null>(null)
  const [installedKinds, setInstalledKinds] = useState<Set<string>>(new Set())
  // `terminal.create` rejections used to leave a blank blinking cursor; each
  // tab now keeps its failure so the rail can name it and offer a retry.
  const [errorByTab, setErrorByTab] = useState<Record<string, string>>({})
  const [retryNonce, setRetryNonce] = useState<Record<string, number>>({})

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
      if (cwd === null) return
      openTerminalTab({ title: preset.label, cwd, command: preset.command })
    },
    [cwd],
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
    if (autoOpened.current || cwd === null || tabs.length > 0) return
    autoOpened.current = true
    openTerminalTab({ title: SHELL_PRESET.label, cwd })
  }, [cwd, tabs.length])

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
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-2">
        <div
          role="group"
          aria-label="Terminals"
          className="ari-scroll flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const active = tab.id === activeId
            return (
              <span
                key={tab.id}
                className={cx('group shrink-0 pr-1', tabClass, active && tabSelected)}
              >
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => activateTerminalTab(tab.id)}
                  className="max-w-32 truncate rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  {tab.title}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => closeTab(tab.id)}
                  className={cx(
                    rowAction,
                    // Quiet tabs show their × on hover or focus; the current one keeps it.
                    !active && 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                  )}
                >
                  <X size={12} aria-hidden />
                </button>
              </span>
            )
          })}
        </div>
        {/* Nothing to launch into without a root — the rail offers the fix
            instead, in the empty state below. */}
        {cwd !== null ? (
          <RailButton
            label="New terminal"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setLauncherAnchor({ x: rect.left, y: rect.bottom + 4 })
            }}
          >
            <Plus size={14} aria-hidden />
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
          className="flex shrink-0 items-center gap-2 border-b border-border py-1 pl-4 pr-2 text-[13px] text-danger"
        >
          <span className="min-w-0 flex-1 truncate" title={activeError}>
            Terminal failed to start: {activeError}
          </span>
          <button type="button" onClick={() => retryTab(activeId)} className={outlineButton}>
            <RotateCcw size={14} aria-hidden /> Retry
          </button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {tabs.length > 0 ? (
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
        ) : cwd === null ? (
          // Parked shells outrank this: a session switch resolves its
          // workspace a beat late, and an open shell must not blink out.
          <EmptyRail message="Add a project to open a terminal — shells run inside a project folder.">
            {onAddProject ? (
              <RailAction
                label="Add project"
                icon={<FolderPlus size={14} aria-hidden />}
                onClick={onAddProject}
              />
            ) : null}
          </EmptyRail>
        ) : (
          <EmptyRail message="No terminal open.">
            <RailAction
              label="Open a terminal"
              icon={<Plus size={14} aria-hidden />}
              onClick={() => spawnPreset(SHELL_PRESET)}
            />
          </EmptyRail>
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
    <button type="button" aria-label={label} title={label} onClick={onClick} className={iconButton}>
      {children}
    </button>
  )
}

function EmptyRail({ message, children }: { message: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
      <p className="max-w-64 text-center text-[13px] text-fg-subtle">{message}</p>
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
    <button type="button" onClick={onClick} className={outlineButton}>
      {icon} {label}
    </button>
  )
}
