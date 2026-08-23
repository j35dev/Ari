import { useCallback, useEffect, useState } from 'react'
import { GitBranch, X } from 'lucide-react'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { MotionProvider } from '@ari/ui/motion-provider'
import { ToastProvider } from '@ari/ui/toast'
import type { SessionSummary } from '@ari/contracts/rpc'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import { rpc } from './lib/rpc'
import { Titlebar } from './shell/Titlebar'
import { GalleryView } from './views'
import { SessionView } from './features/session/SessionView'
import { TerminalView } from './features/terminal'
import { SettingsWorkspace, type SettingsSectionId } from './features/settings'
import { ChangesView } from './features/changes'
import { ProjectsView } from './features/projects'
import { CommandPalette } from './features/palette/CommandPalette'
import { useCommands } from './features/palette/useCommands'
import { BootSplash } from './features/moment'
import {
  SidebarFooter,
  SidebarHeader,
  SessionsUnderProjects,
  type SidebarNavId,
} from './shell/Sidebar'
import { ErrorBoundary } from './shell/ErrorBoundary'
import { WelcomePanel } from './features/welcome'
import './features/transcript/transcript.css'

type InspectorId = Exclude<SidebarNavId, 'session' | 'settings'>

export interface SessionDefaults {
  driverKind: DriverKind
  modelId: string | null
  permissionMode: PermissionMode
}

function Shell() {
  const [inspector, setInspector] = useState<InspectorId | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('appearance')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [workspaceCwd, setWorkspaceCwd] = useState<string>('')
  const [defaults, setDefaults] = useState<SessionDefaults>({
    // Ari Core is the safe default: it works with a user-configured endpoint
    // and never depends on an installed CLI. Detection below upgrades this.
    driverKind: 'ari-core',
    modelId: null,
    permissionMode: 'ask',
  })

  useEffect(() => {
    void rpc
      .invoke('app.info')
      .then((info) => setWorkspaceCwd(info.homeDir))
      .catch(() => undefined)
  }, [])

  const refreshSessions = useCallback((): void => {
    void rpc
      .invoke('session.list')
      .then(setSessions)
      .catch(() => undefined)
  }, [])

  useEffect(refreshSessions, [])

  useEffect(() => {
    void rpc
      .invoke('project.list')
      .then(setProjects)
      .catch(() => undefined)
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
      .catch(() => undefined)
  }, [])

  const commands = useCommands({
    onNavigate: (view) => {
      if (view === 'settings') {
        setSettingsOpen(true)
      } else if (view === 'sessions') {
        setInspector(null)
      } else {
        setInspector(view)
      }
      setPaletteOpen(false)
    },
    onOpenGallery: () => {
      setGalleryOpen(true)
      setPaletteOpen(false)
    },
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
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
  }, [paletteOpen, settingsOpen])

  const createSession = useCallback(
    (overrides?: Partial<SessionDefaults>): void => {
      const effective = { ...defaults, ...overrides }
      // Reuse the newest pristine (zero-message) session when its config is
      // compatible — spamming ✎ must not pile up empty chats.
      const reusable = sessions.find(
        (s) =>
          s.projectId === 'adhoc' &&
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
          projectId: 'adhoc',
          title: 'New session',
          driverKind: effective.driverKind,
          modelId: effective.modelId,
          permissionMode: effective.permissionMode,
        })
        .then(({ sessionId }) => {
          if (overrides) setDefaults(effective)
          setActiveSessionId(sessionId)
          setInspector(null)
          refreshSessions()
        })
        .catch(() => undefined)
    },
    [defaults, sessions, refreshSessions],
  )

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const activeProjectName =
    projects.find((p) => p.id === activeSession?.projectId)?.name ?? ''

  if (settingsOpen) {
    return (
      <div className="flex h-full flex-col">
        <Titlebar projectLabel="" onOpenPalette={() => setPaletteOpen(true)} />
        <SettingsWorkspace
          section={settingsSection}
          onSectionChange={setSettingsSection}
          onBack={() => setSettingsOpen(false)}
        />
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      </div>
    )
  }

  if (galleryOpen) {
    return (
      <div className="flex h-full flex-col bg-bg">
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
    <div className="flex h-full flex-col">
      <Titlebar projectLabel={activeProjectName} onOpenPalette={() => setPaletteOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <aside className="ari-glass flex w-[var(--ari-sidebar-width)] shrink-0 flex-col">
          <SidebarHeader onNewSession={() => createSession()} />
          <SessionsUnderProjects
            sessions={sessions}
            projects={projects}
            activeSessionId={activeSessionId}
            onSelect={(id) => {
              setActiveSessionId(id)
              setInspector(null)
            }}
            onRename={(id, title) => {
              void rpc
                .invoke('command.dispatch', {
                  command: { type: 'session.update', sessionId: id, title },
                })
                .then(refreshSessions)
                .catch(() => undefined)
            }}
            onDelete={(id) => {
              void rpc
                .invoke('session.destroy', { sessionId: id })
                .then(() => {
                  if (activeSessionId === id) setActiveSessionId(null)
                  refreshSessions()
                })
                .catch(() => undefined)
            }}
          />
          <SidebarFooter
            active={settingsOpen ? 'settings' : (inspector ?? 'session')}
            onSelect={(id) => {
              if (id === 'settings') {
                setSettingsOpen(true)
                return
              }
              setSettingsOpen(false)
              if (id === 'session') {
                setInspector(null)
                return
              }
              setInspector((prev) => (prev === id ? null : id))
            }}
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          <header className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border px-4">
            <WorkspaceBreadcrumb
              projectName={activeProjectName}
              sessionTitle={sessions.find((s) => s.id === activeSessionId)?.title ?? ''}
            />
            <div className="flex-1" />
            <BranchChip sessionId={activeSessionId} />
          </header>

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
                  <span className="text-xs font-medium text-fg">
                    {inspector === 'terminal'
                      ? 'Terminal'
                      : inspector === 'changes'
                        ? 'Changes'
                        : 'Projects'}
                  </span>
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
                  {inspector === 'terminal' ? (
                    <ErrorBoundary label="Terminal">
                      <TerminalView cwd={workspaceCwd || undefined} />
                    </ErrorBoundary>
                  ) : inspector === 'changes' ? (
                    <ErrorBoundary label="Changes">
                      <ChangesView
                        sessionId={activeSessionId}
                        projectId={activeSession?.projectId ?? null}
                      />
                    </ErrorBoundary>
                  ) : (
                    <ErrorBoundary label="Projects">
                      <ProjectsView />
                    </ErrorBoundary>
                  )}
                </div>
              </aside>
            ) : null}
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
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
      .catch(() => undefined)
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
    <ThemeProvider>
      <MotionProvider>
        <ToastProvider>{children}</ToastProvider>
      </MotionProvider>
    </ThemeProvider>
  )
}

export function App() {
  const [booted, setBooted] = useState(false)

  useEffect(() => {
    void rpc
      .invoke('ping')
      .then(() => setBooted(true))
      .catch(() => setBooted(true))
  }, [])

  if (!booted) {
    return (
      <AppProviders>
        <BootSplash ready={false} />
      </AppProviders>
    )
  }

  return (
    <AppProviders>
      <Shell />
    </AppProviders>
  )
}
