import { useCallback, useEffect, useState } from 'react'
import {
  FolderGit2,
  GitPullRequest,
  MessageSquare,
  Settings,
  SquarePen,
  TerminalSquare,
} from 'lucide-react'
import { ThemeProvider, useTheme } from '@ari/ui/theme-provider'
import { MotionProvider } from '@ari/ui/motion-provider'
import type { SessionSummary } from '@ari/contracts/rpc'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import { rpc } from './lib/rpc'
import { Titlebar } from './shell/Titlebar'
import { GalleryView } from './views'
import { SessionView } from './features/session/SessionView'
import { TerminalView } from './features/terminal'
import { AppearanceSettings, PermissionsSettings } from './features/settings'
import { EndpointsManager } from './features/endpoints'
import { ChangesView } from './features/changes'
import { ProjectsView } from './features/projects'
import { ProvidersView } from './features/providers'
import { CommandPalette } from './features/palette/CommandPalette'
import { useCommands } from './features/palette/useCommands'
import { BootSplash } from './features/moment'
import { SidebarHeader, SessionsUnderProjects, UtilityStrip } from './shell/Sidebar'
import './features/transcript/transcript.css'

type MainPane = 'session' | 'projects' | 'terminal' | 'changes' | 'settings'

export interface SessionDefaults {
  driverKind: DriverKind
  modelId: string | null
  permissionMode: PermissionMode
}

function Shell() {
  const [pane, setPane] = useState<MainPane>('session')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [defaults, setDefaults] = useState<SessionDefaults>({
    driverKind: 'claude',
    modelId: null,
    permissionMode: 'ask',
  })
  const { theme, setTheme } = useTheme()

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

  // First available CLI becomes the default driver at boot.
  useEffect(() => {
    void rpc
      .invoke('providers.detect')
      .then((detections) => {
        const installed = detections.find(
          (d) => d.binaryPath !== null && d.kind !== 'ari-core',
        )
        if (installed) setDefaults((prev) => ({ ...prev, driverKind: installed.kind as DriverKind }))
      })
      .catch(() => undefined)
  }, [])

  const commands = useCommands({
    onNavigate: (view) => {
      setPane(view === 'sessions' ? 'session' : view)
      setPaletteOpen(false)
    },
    onOpenGallery: () => {
      setGalleryOpen(true)
      setPaletteOpen(false)
    },
    theme,
    setTheme,
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
      if (e.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const createSession = useCallback((): void => {
    void rpc
      .invoke('session.create', {
        projectId: 'adhoc',
        title: 'New session',
        driverKind: defaults.driverKind,
        modelId: defaults.modelId,
        permissionMode: defaults.permissionMode,
      })
      .then(({ sessionId }) => {
        setActiveSessionId(sessionId)
        setPane('session')
        refreshSessions()
      })
      .catch(() => undefined)
  }, [defaults, refreshSessions])

  if (galleryOpen) {
    return (
      <div className="flex h-full flex-col">
        <Titlebar projectLabel="Gallery" />
        <div className="border-b border-border bg-surface-0 px-4 py-2">
          <button
            type="button"
            onClick={() => setGalleryOpen(false)}
            className="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            ← Back to workspace
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <GalleryView />
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <Titlebar projectLabel="" />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[var(--ari-sidebar-width)] shrink-0 flex-col border-r border-border bg-surface-0">
          <SidebarHeader onNewSession={createSession} />
          <SessionsUnderProjects
            sessions={sessions}
            projects={projects}
            activeSessionId={activeSessionId}
            onSelect={(id) => {
              setActiveSessionId(id)
              setPane('session')
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
          <UtilityStrip
            active={pane}
            onSelect={(id) => setPane(id as MainPane)}
            items={[
              { id: 'session', label: 'Sessions', icon: MessageSquare },
              { id: 'projects', label: 'Projects', icon: FolderGit2 },
              { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
              { id: 'changes', label: 'Changes', icon: GitPullRequest },
              { id: 'settings', label: 'Settings', icon: Settings },
            ]}
          />
        </aside>

        <main className="min-w-0 flex-1 bg-bg">
          {pane === 'terminal' ? (
            <TerminalView cwd={process.cwd()} />
          ) : pane === 'changes' ? (
            <ChangesView />
          ) : pane === 'projects' ? (
            <ProjectsView />
          ) : pane === 'settings' ? (
            <div className="ari-scroll h-full overflow-y-auto">
              <div className="mx-auto max-w-2xl space-y-10 p-8">
                <SettingsSection title="Appearance">
                  <AppearanceSettings />
                </SettingsSection>
                <SettingsSection title="Providers">
                  <ProvidersView />
                </SettingsSection>
                <SettingsSection title="Permissions">
                  <PermissionsSettings />
                </SettingsSection>
                <SettingsSection title="Endpoints">
                  <EndpointsManager />
                </SettingsSection>
              </div>
            </div>
          ) : activeSessionId ? (
            <SessionView
              key={activeSessionId}
              sessionId={activeSessionId}
              defaults={defaults}
              onDefaultsChange={setDefaults}
            />
          ) : (
            <EmptyState onCreate={createSession} onOpenGallery={() => setGalleryOpen(true)} />
          )}
        </main>
      </div>

      <footer className="flex h-[var(--ari-statusbar-height)] shrink-0 items-center gap-3 border-t border-border bg-surface-0 px-3 text-2xs text-fg-subtle">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-success" /> ready
        </span>
        <span>
          {sessions.length} session{sessions.length === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <span>v0.1.0</span>
      </footer>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  )
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold text-fg">{title}</h2>
      {children}
    </section>
  )
}

function EmptyState({
  onCreate,
  onOpenGallery,
}: {
  onCreate: () => void
  onOpenGallery: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <SquarePen size={28} className="text-fg-subtle" strokeWidth={1.5} />
      <p className="max-w-xs text-center text-sm text-fg-muted">
        Start a session — your agents are already authenticated.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-1 rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-fg-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        New session
      </button>
      <button
        type="button"
        onClick={onOpenGallery}
        className="text-2xs text-fg-subtle underline-offset-2 hover:text-fg-muted hover:underline"
      >
        browse components
      </button>
    </div>
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

  if (!booted) return <BootSplash ready={false} />

  return (
    <ThemeProvider>
      <MotionProvider>
        <Shell />
      </MotionProvider>
    </ThemeProvider>
  )
}
