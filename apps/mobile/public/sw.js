/* Public app files only. Account data and desktop operations always use the network. */
const VERSION = 'ari-mobile-v5'
const SHELL = `${VERSION}-shell`
const SHELL_FILES = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
]
const NEVER_CACHE = new Set([
  'command',
  'query',
  'info',
  'pair',
  'device',
  'events',
  'auth',
  'me',
  'computers',
  'leases',
  'desktop',
  'admin',
  'authorize',
  '.well-known',
  'health',
  'webhooks',
  'api',
  'remote',
  'rpc',
  'pairing',
  'ws',
])
const HASHED_ASSET = /^\/assets\/[^/]+[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i

function cacheable(response, kind) {
  if (
    response.status !== 200 ||
    response.redirected ||
    !['basic', 'default', 'cors'].includes(response.type)
  )
    return false
  if (response.type === 'cors' && !response.url) return false
  if (response.url) {
    const source = new URL(response.url)
    if (!['http:', 'https:'].includes(source.protocol) || source.origin !== self.location.origin)
      return false
  }
  const policy = response.headers.get('cache-control') ?? ''
  if (/(?:^|,)\s*(?:private|no-store)\b/i.test(policy)) return false
  if (/(?:^|,)\s*(?:\*|cookie|authorization)\s*(?:,|$)/i.test(response.headers.get('vary') ?? ''))
    return false
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (kind === 'html') return type === 'text/html'
  if (kind === 'file') return type.startsWith('image/') || type === 'application/manifest+json'
  return (
    /(?:^|,)\s*public\s*(?:,|$)/i.test(policy) &&
    /^(?:text\/(?:javascript|css)|application\/(?:javascript|wasm)|font\/[^/]+|image\/[^/]+)$/.test(
      type,
    )
  )
}

async function remember(key, response) {
  try {
    const copy = response.clone()
    await (await caches.open(SHELL)).put(key, copy)
  } catch (error) {
    self.console.warn('Ari could not store the offline app shell', error)
  }
}

async function cached(key) {
  try {
    return await (await caches.open(SHELL)).match(key)
  } catch (error) {
    self.console.warn('Ari could not read the offline app shell', error)
    return undefined
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all(
      SHELL_FILES.map(async (path) => {
        const response = await fetch(path, {
          cache: 'reload',
          credentials: 'omit',
          redirect: 'error',
        })
        if (cacheable(response, path === '/' ? 'html' : 'file')) await remember(path, response)
      }),
    ),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('ari-mobile-') && name !== SHELL)
            .map((name) => caches.delete(name)),
        ),
      ),
  )
  // Existing pages retain their worker; activation never claims them mid-task.
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ari.skip-waiting') event.waitUntil(self.skipWaiting())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (
    request.method !== 'GET' ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.origin !== self.location.origin ||
    request.headers.has('authorization') ||
    request.headers.has('range') ||
    request.headers.get('upgrade')?.toLowerCase() === 'websocket'
  )
    return
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return
  }
  if (
    NEVER_CACHE.has(pathname.split('/')[1]) ||
    pathname.includes('\\') ||
    pathname.includes('%') ||
    pathname.startsWith('//')
  )
    return

  if (HASHED_ASSET.test(pathname) && !url.search) {
    event.respondWith(
      (async () => {
        const previous = await cached(request)
        if (previous && cacheable(previous, 'asset')) return previous
        const response = await fetch(request)
        if (cacheable(response, 'asset')) await remember(request, response)
        return response
      })(),
    )
    return
  }

  const html = request.mode === 'navigate' || pathname === '/' || pathname === '/index.html'
  const file = SHELL_FILES.includes(pathname) && pathname !== '/'
  if (!html && !file) return
  event.respondWith(
    (async () => {
      const key = html ? '/' : pathname
      const kind = html ? 'html' : 'file'
      try {
        const response = await fetch(request)
        if (cacheable(response, kind)) await remember(key, response)
        return response
      } catch {
        const previous = await cached(key)
        return previous && cacheable(previous, kind) ? previous : Response.error()
      }
    })(),
  )
})
