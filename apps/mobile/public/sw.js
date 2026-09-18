/*
  The app shell cache (ADR §16).

  Two rules decide everything here. Only same-origin GETs for the app's own
  files are ever cached — every API route is cross-checked against the list
  below and passed straight through, because a cached transcript, diff, or
  grant would be one user's data served to the next person who opens the app.
  And a new worker waits: the page decides when to take an update, so an
  update never lands while someone is typing a prompt or holding an approval
  they have not answered yet.
*/

const VERSION = 'ari-mobile-v2'
const SHELL = `${VERSION}-shell`

/** Never cached, whatever the method or headers say. */
const NEVER_CACHE = ['/command', '/query', '/info', '/pair/', '/device/', '/events']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) =>
      cache.addAll([
        '/',
        '/manifest.webmanifest',
        '/icon.svg',
        '/icon-192.png',
        '/icon-512.png',
        '/apple-touch-icon.png',
      ]),
    ),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)))
      // No clients.claim(): an already-open page keeps the worker it loaded
      // with, so an update cannot change behaviour mid-action.
    })(),
  )
})

self.addEventListener('message', (event) => {
  // The page asks for the update when it is safe, never on its own.
  if (event.data && event.data.type === 'ari.skip-waiting') void self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (NEVER_CACHE.some((path) => url.pathname.startsWith(path))) return

  // The shell itself is fetched fresh so a deploy is picked up on the next
  // launch; only the hashed assets under /assets/ are safe to keep forever.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached !== undefined) return cached
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(SHELL).then((cache) => cache.put(request, copy))
          }
          return response
        })
      }),
    )
    return
  }

  if (request.mode === 'navigate' || url.pathname === '/' || !url.pathname.includes('.')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(SHELL).then((cache) => cache.put('/', copy))
          }
          return response
        })
        .catch(async () => {
          // Offline: the shell still opens and says it cannot reach the
          // desktop, which is more useful than the browser's error page.
          const cached = await caches.match('/')
          return cached ?? Response.error()
        }),
    )
  }
})
