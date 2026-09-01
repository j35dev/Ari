import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, PanelLeftOpen, X } from 'lucide-react'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { MotionProvider } from '@ari/ui/motion-provider'
import { ToastProvider } from '@ari/ui/toast'
import { SessionImportDialog } from './features/providers'
import { useUpdateToasts } from './features/providers/use-update-toasts'
import type { RpcResults, SessionEventFrame, SessionSummary } from '@ari/contracts/rpc'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { rpc } from './lib/rpc'
import { themePersistence } from './lib/theme-persistence'
import { Titlebar } from './shell/Titlebar'
import { GalleryView } from './views'
import { SessionView } from './features/session/SessionView'
import { sidebarOrder } from './features/session/session-nav'
import { TerminalWorkspace } from './features/terminal'
import { SettingsWorkspace, type SettingsSectionId } from './features/settings'
import { KeyboardCheatSheet } from './features/settings/KeyboardCheatSheet'
import { ChangesView } from './features/changes'
import { openProjectViaPicker } from './features/projects/open-project'
import { UsagePage } from './features/usage/UsagePage'
import { FileExplorer } from './features/files/FileExplorer'
import { CommandPalette } from './features/palette/CommandPalette'
import { useCommands } from './features/palette/useCommands'
import { ContentSearchOverlay } from './features/search'
import { AwakenSplash, AWAKEN_MAX_MS } from './features/moment'
import { useSessionActivity } from './features/session/use-session-activity'
import {
  SidebarHeader,
  SessionsUnderProjects,
  type SidebarNavId,
} from './shell/Sidebar'
import { ErrorBoundary } from './shell/ErrorBoundary'
import { SIDEBAR_WIDTH_BOUNDS, useSidebarWidth } from './shell/use-sidebar-width'
import { WelcomePanel } from './features/welcome'
import './features/transcript/transcript.css'

type InspectorId = Exclude<SidebarNavId, 'session' | 'settings' | 'terminal'>

/** Full project registry rows; ids feed lookups, paths feed git/fs panes. */
type ProjectRow = RpcResults['project.list'][number]

export interface SessionDefaults {
  driverKind: DriverKind
  modelId: string | null
  permissionMode: PermissionMode
  effort: string | null
}

function Shell() {
  const [inspector, setInspector] = useState<InspectorId | null>(null)
  // Usage, Changes and the terminal workspace get the full page, not a 520px
  // inspector pane — they're rooms, not tools. Files stays an inspector.
  const [fullPage, setFullPage] = useState<'usage' | 'changes' | 'terminal' | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('appearance')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const { activityOf } = useSessionActivity()
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [importProjectId, setImportProjectId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [workspaceCwd, setWorkspaceCwd] = useState<string>('')
  const [defaults, setDefaults] = useState<SessionDefaults>({
    // Ari Core is the safe default: it works with a user-configured endpoint
    // and never depends on an installed CLI. Detection below upgrades this.
    driverKind: 'ari-core',
    modelId: null,
    permissionMode: 'ask',
    effort: null,
  })

  useEffect(() => {
    void rpc
      .invoke('app.info')
      .then((info) => setWorkspaceCwd(info.homeDir))
      .catch((error: unknown) => log.warn('rpc call failed', error))
  }, [])

  // Sidebar collapse: ephemeral UI state, so localStorage (not engine settings)
  // is the right home. Ctrl+B toggles; a rail button restores it.
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('ari.sidebar.open') !== '0')
  const sidebar = useSidebarWidth()
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      localStorage.setItem('ari.sidebar.open', open ? '0' : '1')
      return !open
    })
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar])

  const refreshSessions = useCallback((): void => {
    void rpc
      .invoke('session.list')
      .then(setSessions)
      .catch((error: unknown) => log.warn("rpc call failed", error))
  }, [])

  // Late-bound so the global key handler (registered before createSession
  // exists) can still trigger new sessions.
  const createSessionRef = useRef<(() => void) | null>(null)

  useEffect(refreshSessions, [])

  // Live sidebar: the engine names a session on its first prompt and bumps
  // message counts as turns run. Without this feed the list only refreshed
  // on explicit actions, so rows kept stale titles and pristine-session
  // reuse kept matching a session that had already started chatting.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = rpc.subscribe('session.events', {}, (payload) => {
      // The contract types frames loosely (`event?: unknown`); only the
      // journal event's discriminant is needed here.
      const event = (payload as Partial<SessionEventFrame> | null)?.event as
        | { type?: string }
        | undefined
      if (
        !event ||
        (event.type !== 'user.message.added' &&
          event.type !== 'session.updated' &&
          event.type !== 'turn.settled')
      ) {
        // Streaming deltas and per-turn noise must not refetch the list.
        return
      }
      if (pending !== null) return // coalescing; the scheduled fetch sees this too
      pending = setTimeout(() => {
        pending = null
        refreshSessions()
      }, 250)
    })
    return () => {
      if (pending !== null) clearTimeout(pending)
      unsubscribe()
    }
  }, [refreshSessions])

  useEffect(() => {
    void rpc
      .invoke('project.list')
      .then(setProjects)
      .catch((error: unknown) => log.warn("rpc call failed", error))
  }, [])

  // First available CLI becomes the default driver at boot; when none is
  // installed, sessions fall back to Ari Core (endpoint-powered).
  useEffect(() => {
    void rpc
      .invoke('providers.detect')
      .then((detections) => {
        const installed = detections.find(
          (d) => d.binaryPath !== null && d.kind !== 'ari-core',
        )
        if (installed) {
          setDefaults((prev) =>
            prev.driverKind === 'ari-core'
              ? { ...prev, driverKind: installed.kind as DriverKind }
              : prev,
          )
        }
      })
      .catch((error: unknown) => log.warn("rpc call failed", error))
  }, [])

  const commands = useCommands({
    onNavigate: (view) => {
      if (view === 'settings') {
        setSettingsOpen(true)
      } else if (view === 'sessions') {
        setInspector(null)
      } else if (view === 'terminal') {
        setInspector(null)
        setFullPage('terminal')
      } else {
        setInspector(view)
      }
      setPaletteOpen(false)
    },
    onOpenGallery: () => {
      setGalleryOpen(true)
      setPaletteOpen(false)
    },
    onOpenSearch: () => {
      setSearchOpen(true)
      setPaletteOpen(false)
    },
  })

  // Sidebar-visible order — the same sequence Mod+1..9 and Ctrl+Tab traverse.
  // Grouped by the open projects so keyboard order matches what is rendered.
  const openProjects = useMemo(() => projects.filter((p) => p.open), [projects])
  const navOrder = useMemo(() => sidebarOrder(sessions, openProjects), [sessions, openProjects])

  const refreshProjects = useCallback((): void => {
    void rpc
      .invoke('project.list')
      .then(setProjects)
      .catch((error: unknown) => log.warn("rpc call failed", error))
  }, [])

  // Native picker → open; a cancelled picker resolves to null (silent no-op).
  // With a project id, the picker starts near that project's folder (Locate).
  const openProjectViaDialog = useCallback(
    (projectId?: string): void => {
      const folder = projectId
        ? projects.find((p) => p.id === projectId)?.path.replace(/[/\\][^/\\]+$/, '')
        : undefined
      void openProjectViaPicker(folder)
        .then((project) => {
          if (project !== null) refreshProjects()
        })
        .catch((error: unknown) => log.warn("rpc call failed", error))
    },
    [refreshProjects, projects],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen((o) => !o)
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        createSessionRef.current?.()
      }
      if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key)) {
        // Mod+1..9 jumps to the nth sidebar row (T3/comet session jumping).
        const target = navOrder[Number(e.key) - 1]
        if (target && !paletteOpen && !searchOpen) {
          e.preventDefault()
          setActiveSessionId(target.id)
          setInspector(null)
        }
      }
      if (e.ctrlKey && e.key === 'Tab') {
        // Ctrl+Tab / Ctrl+Shift+Tab cycle sessions (cross-platform literal).
        if (navOrder.length > 1 && !paletteOpen && !searchOpen) {
          e.preventDefault()
          const index = navOrder.findIndex((s) => s.id === activeSessionId)
          const delta = e.shiftKey ? -1 : 1
          const next =
            index === -1
              ? // No active session: forward opens the newest, backward the oldest.
                (delta === 1 ? navOrder[0] : navOrder[navOrder.length - 1])
              : navOrder[(index + delta + navOrder.length) % navOrder.length]
          if (next) {
            setActiveSessionId(next.id)
            setInspector(null)
          }
        }
      }
      if (e.key === 'Escape') {
        if (paletteOpen) {
          setPaletteOpen(false)
          return
        }
        if (settingsOpen) setSettingsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen, settingsOpen, navOrder, activeSessionId])

  const createSession = useCallback(
    (overrides?: Partial<SessionDefaults>, projectId = 'adhoc'): void => {
      const effective = { ...defaults, ...overrides }
      // Reuse the newest pristine (zero-message) session when its config is
      // compatible — spamming ✎ must not pile up empty chats.
      const reusable = sessions.find(
        (s) =>
          s.projectId === projectId &&
          s.messageCount === 0 &&
          (overrides === undefined || overrides.driverKind === undefined),
      )
      if (reusable) {
        if (overrides) setDefaults(effective)
        setActiveSessionId(reusable.id)
        setInspector(null)
        return
      }
      void rpc
        .invoke('session.create', {
          projectId,
          title: 'New session',
          driverKind: effective.driverKind,
          modelId: effective.modelId,
          permissionMode: effective.permissionMode,
          effort: effective.effort,
        })
        .then(({ sessionId }) => {
          if (overrides) setDefaults(effective)
          setActiveSessionId(sessionId)
          setInspector(null)
          refreshSessions()
        })
        .catch((error: unknown) => log.warn("rpc call failed", error))
    },
    [defaults, sessions, refreshSessions],
  )
  createSessionRef.current = createSession

  const selectWorkspaceTool = useCallback((id: SidebarNavId): void => {
    if (id === 'settings') {
      setSettingsOpen(true)
      setFullPage(null)
      setInspector(null)
      return
    }
    setSettingsOpen(false)
    if (id === 'session') {
      setInspector(null)
      setFullPage(null)
      return
    }
    if (id === 'usage' || id === 'changes' || id === 'terminal') {
      setInspector(null)
      setFullPage((prev) => (prev === id ? null : id))
      return
    }
    setFullPage(null)
    setInspector((prev) => (prev === id ? null : id))
  }, [])

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const activeProjectName =
    projects.find((p) => p.id === activeSession?.projectId)?.name ?? ''
  // The explorer roots at the active session's project, falling back to the
  // first registered project so the pane is never dead on arrival.
  const activeProjectPath =
    projects.find((p) => p.id === activeSession?.projectId)?.path ??
    projects[0]?.path ??
    null

  if (settingsOpen) {
    return (
      <div className="ari-glass-pane flex h-full flex-col">
        <Titlebar projectLabel="" />
        <SettingsWorkspace
          section={settingsSection}
          onSectionChange={setSettingsSection}
          onBack={() => setSettingsOpen(false)}
          onOpenTerminal={() => {
            setSettingsOpen(false)
            setInspector(null)
            setFullPage('terminal')
          }}
        />
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
        <KeyboardCheatSheet />
      </div>
    )
  }

  if (galleryOpen) {
    return (
      <div className="ari-glass-pane flex h-full flex-col bg-bg">
        <header className="flex h-[var(--ari-titlebar-height)] shrink-0 items-center gap-2 pl-3">
          <span className="text-fg text-xs font-semibold tracking-[0.18em]">ARI</span>
          <span className="text-fg-subtle text-xs">/</span>
          <span className="text-fg-muted text-xs">Component gallery</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setGalleryOpen(false)}
            className="mr-3 flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface-1 px-3 text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            ← Back to workspace
          </button>
        </header>
        <div className="min-h-0 flex-1">
          <GalleryView />
        </div>
      </div>
    )
  }

  return (
    <div className="ari-glass-pane flex h-full flex-col">
      <Titlebar
        projectLabel={activeProjectName}
        activeTool={settingsOpen ? 'settings' : (fullPage ?? inspector)}
        onSelectTool={selectWorkspaceTool}
      />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen ? (
          <aside
            className="ari-glass flex shrink-0 flex-col"
            style={{ width: sidebar.width }}
          >
            <SidebarHeader onNewSession={() => createSession()} onCollapse={toggleSidebar} />
          <SessionsUnderProjects
            sessions={sessions}
            projects={openProjects}
            knownProjectNames={projects.map((p) => ({ id: p.id, name: p.name }))}
            onOpenProject={openProjectViaDialog}
            onNewSessionInProject={(projectId) => createSession(undefined, projectId)}
            onImportSessions={setImportProjectId}
            onRevealProject={(projectId) => {
              const path = projects.find((p) => p.id === projectId)?.path
              if (path === undefined) return
              void rpc.invoke('shell.revealPath', { path }).catch((error: unknown) => log.warn("rpc call failed", error))
            }}
            onCloseProject={(projectId) => {
              void rpc
                .invoke('project.close', { id: projectId })
                .then(refreshProjects)
                .catch((error: unknown) => log.warn("rpc call failed", error))
            }}
            onRemoveProject={(projectId) => {
              void rpc
                .invoke('project.remove', { id: projectId })
                .then(refreshProjects)
                .catch((error: unknown) => log.warn("rpc call failed", error))
            }}
            onLocateProject={openProjectViaDialog}
            activeSessionId={activeSessionId}
            activityOf={activityOf}
            onSelect={(id) => {
              setActiveSessionId(id)
              setInspector(null)
              // Selecting a chat must land on it, not leave Usage/Changes up.
              setFullPage(null)
            }}
            onRename={(id, title) => {
              void rpc
                .invoke('command.dispatch', {
                  command: { type: 'session.update', sessionId: id, title },
                })
                .then(refreshSessions)
                .catch((error: unknown) => log.warn("rpc call failed", error))
            }}
            onDelete={(id) => {
              void rpc
                .invoke('session.destroy', { sessionId: id })
                .then(() => {
                  if (activeSessionId === id) setActiveSessionId(null)
                  refreshSessions()
                })
                .catch((error: unknown) => log.warn("rpc call failed", error))
            }}
            onTogglePin={(id, pinned) => {
              void rpc
                .invoke('command.dispatch', {
                  command: { type: 'session.update', sessionId: id, pinned },
                })
                .then(refreshSessions)
                .catch((error: unknown) => log.warn("rpc call failed", error))
            }}
            onToggleArchive={(id, archived) => {
              void rpc
                .invoke('command.dispatch', {
                  command: { type: 'session.update', sessionId: id, archived },
                })
                .then(refreshSessions)
                .catch((error: unknown) => log.warn("rpc call failed", error))
            }}
          />
          </aside>
        ) : null}

        {sidebarOpen ? (
          <div
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuenow={sidebar.width}
            aria-valuemin={SIDEBAR_WIDTH_BOUNDS.min}
            aria-valuemax={SIDEBAR_WIDTH_BOUNDS.max}
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            {...sidebar.handleProps}
            className={`w-1 shrink-0 cursor-col-resize transition-colors focus-visible:outline-none focus-visible:bg-accent ${
              sidebar.dragging ? 'bg-accent' : 'bg-transparent hover:bg-accent-subtle'
            }`}
          />
        ) : null}

        <main className="flex min-w-0 flex-1 flex-col bg-bg border-l border-border">
          <header className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border px-4">
            {!sidebarOpen ? (
              <button
                type="button"
                aria-label="Expand sidebar"
                title="Expand sidebar (Ctrl+B)"
                onClick={toggleSidebar}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                <PanelLeftOpen size={15} />
              </button>
            ) : null}
            <WorkspaceBreadcrumb
              projectName={activeProjectName}
              sessionTitle={sessions.find((s) => s.id === activeSessionId)?.title ?? ''}
            />
            <div className="flex-1" />
            <BranchChip sessionId={activeSessionId} />
          </header>

          {fullPage !== null ? (
            <div className="min-h-0 flex-1">
              {fullPage === 'usage' ? (
                <ErrorBoundary label="Usage">
                  <UsagePage />
                </ErrorBoundary>
              ) : fullPage === 'terminal' ? (
                <ErrorBoundary label="Terminal">
                  <TerminalWorkspace cwd={(activeProjectPath ?? workspaceCwd) || undefined} />
                </ErrorBoundary>
              ) : (
                <ErrorBoundary label="Changes">
                  <ChangesView
                    sessionId={activeSessionId}
                    projectId={activeSession?.projectId ?? null}
                  />
                </ErrorBoundary>
              )}
            </div>
          ) : (
          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 min-w-0 flex-1">
              {activeSessionId ? (
                <ErrorBoundary label="Session">
                  <SessionView
                    key={activeSessionId}
                    sessionId={activeSessionId}
                    defaults={defaults}
                    onDefaultsChange={setDefaults}
                  />
                </ErrorBoundary>
              ) : (
                <ErrorBoundary label="Welcome">
                  <WelcomePanel
                    onCreateSession={() => createSession()}
                    onConnect={(endpointId) =>
                      createSession({ driverKind: 'ari-core', modelId: `ep:${endpointId}` })
                    }
                  />
                </ErrorBoundary>
              )}
            </div>
            {inspector ? (
              <aside className="flex w-[min(520px,46vw)] shrink-0 flex-col border-l border-border">
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
                  <span className="text-xs font-medium text-fg">Changes</span>
                  <div className="flex-1" />
                  <button
                    type="button"
                    aria-label="Close inspector"
                    onClick={() => setInspector(null)}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  {inspector === 'changes' ? (
                    <ErrorBoundary label="Changes">
                      <ChangesView
                        sessionId={activeSessionId}
                        projectId={activeSession?.projectId ?? null}
                      />
                    </ErrorBoundary>
                  ) : activeProjectPath ? (
                    <FileExplorer root={activeProjectPath} />
                  ) : (
                    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-fg-subtle">
                      Open a project first — the explorer browses its folder.
                    </div>
                  )}
                </div>
              </aside>
            ) : null}
          </div>
          )}
        </main>
      </div>

      {importProjectId !== null ? (
        <SessionImportDialog
          open
          project={projects.find((project) => project.id === importProjectId) ?? {
            id: importProjectId,
            name: 'Project',
          }}
          onClose={() => setImportProjectId(null)}
          onImported={(sessionId) => {
            refreshSessions()
            setActiveSessionId(sessionId)
            setInspector(null)
            setFullPage(null)
          }}
        />
      ) : null}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <ContentSearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} root={activeProjectPath} />
      <KeyboardCheatSheet />
    </div>
  )
}

/** Breadcrumb for the active workspace surface (T3's `Ari / thread` pattern). */
function WorkspaceBreadcrumb({
  projectName,
  sessionTitle,
}: {
  projectName: string
  sessionTitle: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      <span className="max-w-40 truncate font-medium text-fg">{projectName || 'Workspace'}</span>
      {sessionTitle ? (
        <>
          <span className="text-fg-subtle">/</span>
          <span className="max-w-72 truncate text-fg-muted">{sessionTitle}</span>
        </>
      ) : null}
    </div>
  )
}

/**
 * Resolves a project id to its registered filesystem path. `git.status`
 * expects a folder, and project ids are opaque — only `project.list` rows
 * carry the real path.
 */
export function resolveProjectPath(
  projects: { id: string; path: string }[],
  projectId: string,
): string | null {
  return projects.find((p) => p.id === projectId)?.path ?? null
}

/**
 * Contextual branch readout in the workspace header: shows the active
 * session's git branch. Resolves the session's project id through
 * session.load, maps it to the registered folder via project.list, then asks
 * git.status for the branch; hides entirely outside repos or without an
 * active session.
 */
export function BranchChip({ sessionId }: { sessionId: string | null }) {
  const [branch, setBranch] = useState<string | null>(null)

  useEffect(() => {
    setBranch(null)
    if (sessionId === null) return
    let cancelled = false
    void rpc
      .invoke('session.load', { sessionId })
      .then(async (model) => {
        const session = (model as { session?: { projectId?: string } | null } | null)?.session
        const projectId = session?.projectId
        if (!projectId) return
        const projects = await rpc.invoke('project.list')
        const projectPath = resolveProjectPath(projects, projectId)
        if (!projectPath) return
        return rpc.invoke('git.status', { path: projectPath }).then((status) => {
          if (!cancelled && status.isRepo && status.branch) setBranch(status.branch)
        })
      })
      .catch((error: unknown) => log.warn("rpc call failed", error))
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (branch === null) return null
  return (
    <span
      className="mr-1 flex h-7 items-center gap-1 rounded-full border border-border bg-surface-1 px-2.5 font-mono text-2xs text-fg-muted"
      title="Active branch"
    >
      <GitBranch size={11} aria-hidden="true" />
      <span className="max-w-40 truncate">{branch}</span>
    </span>
  )
}

/** Theme, motion, and toast context for the whole renderer tree. */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider persistence={themePersistence}>
      <MotionProvider>
        <ToastProvider>
          <UpdateToastWatcher />
          {children}
        </ToastProvider>
      </MotionProvider>
    </ThemeProvider>
  )
}

/** Headless: announces provider updates once the toast context exists. */
function UpdateToastWatcher() {
  useUpdateToasts()
  return null
}

const log = createLogger('app:shell')

/**
 * Startup: the launch animation is the window's own first frame, so the
 * splash overlays the shell rather than living in a second window. The shell
 * mounts underneath as soon as the engine answers, and the splash's outro
 * wipes away to reveal it already painted.
 */
export function App() {
  const [booted, setBooted] = useState(false)
  const [launched, setLaunched] = useState(false)

  useEffect(() => {
    void rpc
      .invoke('ping')
      .then(() => setBooted(true))
      .catch(() => setBooted(true))
    // A wedged engine must not hide the UI behind the splash forever; the
    // splash lifts at the same ceiling, so the shell is what's underneath.
    const ceiling = setTimeout(() => setBooted(true), AWAKEN_MAX_MS)
    return () => clearTimeout(ceiling)
  }, [])

  const finishLaunch = useCallback(() => {
    setLaunched(true)
    delete document.documentElement.dataset['ariBooting']
  }, [])

  return (
    <AppProviders>
      {booted ? <Shell /> : null}
      {launched ? null : <AwakenSplash ready={booted} onDone={finishLaunch} />}
    </AppProviders>
  )
}
