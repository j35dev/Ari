import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ThemeProvider, useTheme, THEMES } from '@ari/ui/theme-provider'
import { MotionProvider } from '@ari/ui/motion-provider'
import type { SessionSummary } from '@ari/contracts/rpc'
import { rpc } from './lib/rpc'
import { Titlebar } from './shell/Titlebar'
import { LeftRail, type RailView } from './shell/LeftRail'
import { SessionsSidebar } from './shell/SessionsSidebar'

type Route = 'home'

function Shell() {
  const [route] = useState<Route>('home')
  const [railView, setRailView] = useState<RailView>('sessions')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  useEffect(() => {
    void rpc
      .invoke('session.list')
      .then(setSessions)
      .catch(() => undefined)
  }, [])

  if (route !== 'home') return null

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
                      return rpc.invoke('session.list').then(setSessions)
                    })
                    .catch(() => undefined)
                }}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <main className="min-w-0 flex-1 bg-bg">
          <EmptyState />
        </main>
      </div>
      <StatusBar />
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <div className="text-xl font-semibold tracking-[0.14em] text-fg">ARI</div>
      <p className="max-w-xs text-center text-sm text-fg-muted">
        Your agents, one surface. Create a session to begin.
      </p>
      <ThemeDots />
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

function StatusBar() {
  return (
    <footer className="flex h-[var(--ari-statusbar-height)] shrink-0 items-center gap-3 border-t border-border bg-surface-0 px-3 text-2xs text-fg-subtle">
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full bg-success" /> engine ready
      </span>
      <span>0 active runs</span>
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
