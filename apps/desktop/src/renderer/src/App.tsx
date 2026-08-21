import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ThemeProvider, useTheme, THEMES } from '@ari/ui/theme-provider'
import { MotionProvider } from '@ari/ui/motion-provider'
import type { SessionSummary } from '@ari/contracts/rpc'
import { rpc } from './lib/rpc'
import { Titlebar } from './shell/Titlebar'
import { LeftRail, type RailView } from './shell/LeftRail'
import { SessionsSidebar } from './shell/SessionsSidebar'
import { GalleryView } from './views'
import { SessionView } from './features/session/SessionView'
import { TerminalView } from './features/terminal'
import { AppearanceSettings, PermissionsSettings } from './features/settings'
import { EndpointsManager } from './features/endpoints'
import { ChangesView } from './features/changes'
import './features/transcript/transcript.css'

type Route = 'home' | 'gallery'

function Shell() {
  const [route, setRoute] = useState<Route>('home')
  const [railView, setRailView] = useState<RailView>('sessions')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const refreshSessions = (): void => {
    void rpc
      .invoke('session.list')
      .then(setSessions)
      .catch(() => undefined)
  }

  useEffect(refreshSessions, [])

  if (route === 'gallery') {
    return (
      <div className="flex h-full flex-col">
        <Titlebar projectLabel="Gallery" />
        <div className="border-b border-border bg-surface-0 px-4 py-2">
          <button
            type="button"
            onClick={() => setRoute('home')}
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
        <LeftRail
          active={railView}
          onSelect={(v) => {
            setRailView(v)
            if (v === 'sessions') setSidebarOpen(true)
          }}
        />
        <AnimatePresence initial={false}>
          {railView === 'sessions' ? (
            <motion.div key="sidebar" className="flex" exit={{ width: 0 }}>
              <SessionsSidebar
                open={sidebarOpen}
                sessions={sessions}
                activeSessionId={activeSessionId}
                onToggle={() => setSidebarOpen((o) => !o)}
                onSelectSession={setActiveSessionId}
                onNewSession={() => {
                  void rpc
                    .invoke('session.create', {
                      projectId: 'adhoc',
                      title: `Session ${new Date().toLocaleTimeString()}`,
                      driverKind: 'claude',
                      modelId: null,
                      permissionMode: 'ask',
                    })
                    .then(({ sessionId }) => {
                      setActiveSessionId(sessionId)
                      refreshSessions()
                    })
                    .catch(() => undefined)
                }}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <main className="min-w-0 flex-1 bg-bg">
          {railView === 'terminal' ? (
            <TerminalView cwd={process.cwd()} />
          ) : railView === 'changes' ? (
            <ChangesView />
          ) : railView === 'settings' ? (
            <div className="ari-scroll h-full overflow-y-auto">
              <div className="mx-auto max-w-2xl space-y-10 p-8">
                <AppearanceSettings />
                <PermissionsSettings />
                <EndpointsManager />
              </div>
            </div>
          ) : activeSessionId ? (
            <SessionView sessionId={activeSessionId} />
          ) : (
            <EmptyState onOpenGallery={() => setRoute('gallery')} />
          )}
        </main>
      </div>
      <StatusBar sessionCount={sessions.length} active={activeSessionId !== null} />
    </div>
  )
}

function EmptyState({ onOpenGallery }: { onOpenGallery: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <div className="text-xl font-semibold tracking-[0.14em] text-fg">ARI</div>
      <p className="max-w-xs text-center text-sm text-fg-muted">
        Your agents, one surface. Create a session to begin.
      </p>
      <ThemeDots />
      <button
        type="button"
        onClick={onOpenGallery}
        className="mt-2 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        Browse component gallery
      </button>
    </div>
  )
}

function ThemeDots() {
  const { theme, setTheme } = useTheme()
  return (
    <div className="mt-1 flex gap-2" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setTheme(t.id)}
          aria-pressed={theme === t.id}
          title={t.label}
          className={`h-5 w-5 rounded-full border transition-transform hover:scale-110 ${
            theme === t.id ? 'border-accent ring-2 ring-accent-ring' : 'border-border-strong'
          }`}
          style={{ background: 'var(--ari-accent)' }}
        />
      ))}
    </div>
  )
}

function StatusBar({
  sessionCount,
  active,
}: {
  sessionCount: number
  active: boolean
}) {
  return (
    <footer className="flex h-[var(--ari-statusbar-height)] shrink-0 items-center gap-3 border-t border-border bg-surface-0 px-3 text-2xs text-fg-subtle">
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-success" /> engine ready
      </span>
      <span>
        {sessionCount} session{sessionCount === 1 ? '' : 's'}
        {active ? ' · viewing' : ''}
      </span>
      <div className="flex-1" />
      <span>v0.1.0</span>
    </footer>
  )
}

export function App() {
  return (
    <ThemeProvider>
      <MotionProvider>
        <Shell />
      </MotionProvider>
    </ThemeProvider>
  )
}
