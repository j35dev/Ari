import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { HomeScreen } from '../features/home/HomeScreen'
import { SettingsScreen } from '../features/settings/SettingsScreen'
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

/**
 * One list, and screens pushed over it. Every push is a history entry, so the
 * system back gesture is the back button.
 */
export function AppShell(): ReactNode {
  const [route, setRoute] = useState(() => readRoute(location.href))
  const [updateReady, setUpdateReady] = useState(false)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
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
  /** Back to where this screen was pushed from, or to home when it was opened by a link. */
  const back = (): void => {
    if ((history.state as { ariMobile?: boolean } | null)?.ariMobile === true) history.back()
    else {
      const home: MobileRoute =
        route.sessionId !== null
          ? { ...route, sessionId: null }
          : { destination: 'home', sessionId: null }
      history.replaceState(null, '', routeUrl(home, location.href))
      setRoute(home)
    }
  }
  if (route.sessionId !== null)
    return (
      <Suspense
        fallback={
          <div className="mobile-shell p-5">
            <p role="status" className="text-sm text-fg-muted">
              Opening session…
            </p>
          </div>
        }
      >
        <div key={route.sessionId} className="screen-push h-full">
          <SessionScreen sessionId={route.sessionId} onForked={onOpen} onBack={back} />
        </div>
      </Suspense>
    )
  if (route.destination === 'settings')
    return (
      <div className="mobile-shell screen-push">
        <SettingsScreen onBack={back} />
      </div>
    )
  return (
    <div className="mobile-shell">
      {updateReady && !updateDismissed && (
        <UpdateBanner onApply={applyUpdate} onDismiss={() => setUpdateDismissed(true)} />
      )}
      <main className="min-h-0 flex-1 overflow-hidden">
        <HomeScreen
          onOpen={onOpen}
          onNewSession={() => setSheetOpen(true)}
          onSettings={() => navigate({ destination: 'settings', sessionId: null })}
        />
      </main>
      {sheetOpen && (
        <Suspense fallback={null}>
          <NewSessionSheet
            onClose={() => setSheetOpen(false)}
            onOpen={(id) => {
              setSheetOpen(false)
              onOpen(id)
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
