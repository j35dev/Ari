export type Destination = 'home' | 'settings'
export interface MobileRoute {
  destination: Destination
  sessionId: string | null
}

/** Routes use the query string so invitation fragments remain private and disposable. */
export function readRoute(href: string): MobileRoute {
  const params = new URL(href).searchParams
  return {
    destination: params.get('view') === 'settings' ? 'settings' : 'home',
    sessionId: params.get('session'),
  }
}

/** Preserve the serving path: a private gateway and the hosted PWA share this router. */
export function routeUrl(route: MobileRoute, href: string): string {
  const url = new URL(href)
  url.searchParams.delete('view')
  url.searchParams.delete('session')
  if (route.destination !== 'home') url.searchParams.set('view', route.destination)
  if (route.sessionId !== null) url.searchParams.set('session', route.sessionId)
  return url.pathname + url.search + url.hash
}
