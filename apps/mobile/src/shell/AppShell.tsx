import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Folder, Inbox, MessageSquare, Settings } from 'lucide-react'
import { NowScreen } from '../features/now/NowScreen'
import { ProjectsScreen } from '../features/projects/ProjectsScreen'
import { SessionsScreen } from '../features/sessions/SessionsScreen'
import { SettingsScreen } from '../features/settings/SettingsScreen'
import { useApp } from '../lib/app-state'
import { connectionLabel } from '../lib/format'
import { readRoute, routeUrl, type MobileRoute } from '../lib/routes'
import { UpdateBanner, applyUpdate, registerServiceWorker } from '../lib/service-worker'

const SessionScreen = lazy(async () => {
  const module = await import('../features/session/SessionScreen')
  return { default: module.SessionScreen }
})
const NewSessionSheet = lazy(async () => {
  const module = await import('../features/projects/NewSessionSheet')
  return { default: module.NewSessionSheet }
})

const destinations = [
  { id: 'sessions', label: 'Sessions', icon: MessageSquare },
  { id: 'projects', label: 'Projects', icon: Folder },
  { id: 'now', label: 'Inbox', icon: Inbox },
  { id: 'settings', label: 'Settings', icon: Settings },
] as const

/** The same workbench for a private tailnet and an approved Ari Connect computer. */
export function AppShell(): ReactNode {
  const app = useApp()
  const [route, setRoute] = useState(() => readRoute(location.href))
  const [updateReady, setUpdateReady] = useState(false)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [newProject, setNewProject] = useState<string | undefined>(undefined)
  const navigate = (next: MobileRoute): void => {
    const url = routeUrl(next, location.href)
    if (new URL(url, location.href).href === location.href) return
    history.pushState({ ariMobile: true }, '', url)
    setRoute(next)
  }
  useEffect(() => {
    const pop = (): void => setRoute(readRoute(location.href))
    window.addEventListener('popstate', pop)
    registerServiceWorker(() => setUpdateReady(true))
    return () => window.removeEventListener('popstate', pop)
  }, [])
  const onOpen = (sessionId: string): void => navigate({ ...route, sessionId })
  if (route.sessionId !== null)
    return (
      <Suspense
        fallback={
          <div className="mobile-shell p-5">
            <p role="status" className="text-sm text-fg-muted">
              Opening workspace…
            </p>
          </div>
        }
      >
        <SessionScreen
          key={route.sessionId}
          sessionId={route.sessionId}
          onForked={onOpen}
          onBack={() => {
            if ((history.state as { ariMobile?: boolean } | null)?.ariMobile === true)
              history.back()
            else {
              const next = { ...route, sessionId: null }
              history.replaceState(null, '', routeUrl(next, location.href))
              setRoute(next)
            }
          }}
        />
      </Suspense>
    )
  const connected = app.connection === 'connected'
  const running = app.sessions.filter((session) => session.status === 'running').length
  const hostname = app.origin === null ? null : new URL(app.origin).hostname
  const host =
    hostname === null
      ? 'Choose a computer'
      : ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
        ? 'This computer'
        : hostname.split('.')[0]
  return (
    <div className="mobile-shell">
      {updateReady && !updateDismissed && (
        <UpdateBanner onApply={applyUpdate} onDismiss={() => setUpdateDismissed(true)} />
      )}
      <header className="flex shrink-0 items-center justify-between border-b border-border px-5 pb-3 pt-[max(0.9rem,env(safe-area-inset-top))]">
        <span className="text-[21px] font-semibold tracking-[-0.06em]">
          ari<span className="text-accent">.</span>
        </span>
        <button
          type="button"
          onClick={() => navigate({ destination: 'settings', sessionId: null })}
          className="flex min-h-11 max-w-[75%] items-center gap-2 rounded-full border border-border bg-surface-1 px-3 text-xs"
          aria-label={`Computer: ${host}. ${connectionLabel(app.connection)}`}
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${connected ? 'bg-success' : 'bg-warning'}`}
          />
          <span className="truncate">{host}</span>
          <ChevronDown size={13} className="shrink-0 text-fg-subtle" />
        </button>
      </header>
      {!connected && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-3 border-b border-border bg-warning-subtle px-5 py-2 text-xs"
        >
          <span className="flex-1">
            {connectionLabel(app.connection)}. Your agents continue on the desktop.
          </span>
          <button
            type="button"
            className="min-h-11 font-medium"
            onClick={() => void app.reconnect()}
          >
            Retry
          </button>
        </div>
      )}
      <main className="min-h-0 flex-1 overflow-hidden">
        {route.destination === 'sessions' && (
          <SessionsScreen onOpen={onOpen} onNewSession={() => setSheetOpen(true)} />
        )}
        {route.destination === 'projects' && (
          <ProjectsScreen
            onOpen={onOpen}
            onNewSession={(projectId) => {
              setNewProject(projectId)
              setSheetOpen(true)
            }}
          />
        )}
        {route.destination === 'now' && <NowScreen onOpen={onOpen} />}
        {route.destination === 'settings' && <SettingsScreen />}
      </main>
      {sheetOpen && (
        <Suspense
          fallback={
            <p
              role="status"
              className="fixed bottom-20 left-0 right-0 bg-surface-1 p-4 text-center text-sm"
            >
              Opening new session…
            </p>
          }
        >
          <NewSessionSheet
            {...(newProject === undefined ? {} : { projectId: newProject })}
            onClose={() => {
              setSheetOpen(false)
              setNewProject(undefined)
            }}
            onOpen={(id) => {
              setSheetOpen(false)
              setNewProject(undefined)
              onOpen(id)
            }}
          />
        </Suspense>
      )}
      <nav
        aria-label="Main"
        className="shrink-0 border-t border-border bg-surface-0 pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="flex px-2 py-1">
          {destinations.map(({ id, label, icon: Icon }) => (
            <li key={id} className="flex-1">
              <button
                type="button"
                aria-current={route.destination === id ? 'page' : undefined}
                onClick={() => navigate({ destination: id, sessionId: null })}
                className={`relative flex min-h-14 w-full flex-col items-center justify-center gap-1 text-[11px] ${route.destination === id ? 'font-medium text-fg' : 'text-fg-subtle'}`}
              >
                <span
                  className={`relative flex h-7 w-12 items-center justify-center rounded-lg ${route.destination === id ? 'bg-surface-2' : ''}`}
                >
                  <Icon size={19} strokeWidth={1.7} />
                  {id === 'sessions' && running > 0 && (
                    <span
                      className="absolute right-1 top-0 size-1.5 rounded-full bg-success"
                      aria-label={`${running} running`}
                    />
                  )}
                </span>
                {label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}
