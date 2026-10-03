import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const origin = 'https://connect.ari.test'
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
interface WorkerEvent {
  request?: Request
  data?: unknown
  waitUntil(promise: Promise<unknown>): void
  respondWith(promise: Promise<Response>): void
}
function html(body = 'public shell', headers: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      ...headers,
    },
  })
}
function worker() {
  const listeners = new Map<string, (event: WorkerEvent) => void>()
  const stores = new Map<string, Map<string, Response>>()
  const key = (input: Request | string) =>
    new URL(typeof input === 'string' ? input : input.url, origin).href
  const network = vi.fn(async (input: Request | string) => {
    const path = new URL(key(input)).pathname
    if (path.startsWith('/assets/'))
      return new Response('bundle', {
        headers: {
          'content-type': 'text/javascript',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      })
    if (path === '/manifest.webmanifest')
      return new Response('{}', {
        headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' },
      })
    return path === '/'
      ? html()
      : new Response('icon', {
          headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' },
        })
  })
  const skipWaiting = vi.fn(async () => {})
  const claim = vi.fn(async () => {})
  const warn = vi.fn()
  const write = vi.fn(
    async (entries: Map<string, Response>, input: Request | string, response: Response) => {
      entries.set(key(input), response.clone())
    },
  )
  const storage = {
    async open(name: string) {
      let entries = stores.get(name)
      if (!entries) {
        entries = new Map()
        stores.set(name, entries)
      }
      const current = entries
      return {
        async match(input: Request | string) {
          return current.get(key(input))?.clone()
        },
        async put(input: Request | string, response: Response) {
          await write(current, input, response)
        },
      }
    },
    async keys() {
      return [...stores.keys()]
    },
    async delete(name: string) {
      return stores.delete(name)
    },
  }
  runInNewContext(source, {
    self: {
      location: { origin },
      console: { warn },
      clients: { claim },
      skipWaiting,
      addEventListener(type: string, listener: (event: WorkerEvent) => void) {
        listeners.set(type, listener)
      },
    },
    caches: storage,
    fetch: network,
    URL,
    Response,
  })
  async function dispatch(
    type: string,
    details: { request?: Request; data?: unknown } = {},
  ): Promise<Response | undefined> {
    const pending: Promise<unknown>[] = []
    let reply: Promise<Response> | undefined
    let dispatching = true
    listeners.get(type)?.({
      ...details,
      waitUntil(promise) {
        if (!dispatching) throw new Error('Late event lifetime extension is forbidden')
        pending.push(promise)
      },
      respondWith(promise) {
        reply = promise
      },
    })
    dispatching = false
    const response = await reply
    for (const promise of pending) await promise
    return response
  }
  const fetchEvent = (path: string, options: RequestInit = {}, navigate = false) => {
    const request = new Request(new URL(path, origin), options)
    if (navigate) Object.defineProperty(request, 'mode', { value: 'navigate' })
    return dispatch('fetch', { request })
  }
  return { dispatch, fetchEvent, stores, storage, network, skipWaiting, claim, warn, write }
}

describe('actual service worker cache behavior', () => {
  it('installs only public shell files without activating or claiming existing pages', async () => {
    const sw = worker()
    await sw.dispatch('install')
    expect(sw.network).toHaveBeenCalledTimes(6)
    const entries = sw.stores.get('ari-mobile-v5-shell')!
    expect([...entries.keys()].map((url) => new URL(url).pathname)).toEqual([
      '/',
      '/manifest.webmanifest',
      '/icon.svg',
      '/icon-192.png',
      '/icon-512.png',
      '/apple-touch-icon.png',
    ])
    expect(sw.network).toHaveBeenCalledWith('/', {
      cache: 'reload',
      credentials: 'omit',
      redirect: 'error',
    })
    expect(sw.skipWaiting).not.toHaveBeenCalled()
    expect(sw.claim).not.toHaveBeenCalled()
  })
  it('deletes only previous Ari caches and requires an explicit update message', async () => {
    const sw = worker()
    for (const name of [
      'ari-mobile-v1-shell',
      'ari-mobile-v4-shell',
      'ari-mobile-v40-shell',
      'ari-mobile-v5-shell',
      'another-app-cache',
    ])
      await sw.storage.open(name)
    await sw.dispatch('activate')
    expect([...sw.stores.keys()]).toEqual(['ari-mobile-v5-shell', 'another-app-cache'])
    expect(sw.claim).not.toHaveBeenCalled()
    expect(sw.skipWaiting).not.toHaveBeenCalled()
    await sw.dispatch('message', { data: { type: 'unrelated' } })
    expect(sw.skipWaiting).not.toHaveBeenCalled()
    await sw.dispatch('message', { data: { type: 'ari.skip-waiting' } })
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1)
  })
  it('never intercepts account/API/auth, mutation, websocket, cross-origin or credential-bearing requests', async () => {
    const sw = worker()
    for (const path of [
      '/command',
      '/query',
      '/info',
      '/pair/start',
      '/device/one',
      '/events',
      '/auth/callback?code=secret',
      '/me',
      '/computers/id',
      '/leases/renew',
      '/desktop/authorize',
      '/admin/members',
      '/authorize/id',
      '/.well-known/jwks.json',
      '/health',
      '/webhooks/workos',
      '/api/sessions',
      '/remote/files',
      '/rpc',
      '/pairing',
      '/ws',
      '/%61uth/callback',
      '/%2561uth/callback',
      '/%broken',
    ])
      expect(await sw.fetchEvent(path, {}, true), path).toBeUndefined()
    expect(await sw.fetchEvent('/', { method: 'POST' })).toBeUndefined()
    expect(await sw.fetchEvent('https://computer.remote.ari.test/')).toBeUndefined()
    expect(await sw.fetchEvent('wss://connect.ari.test/events')).toBeUndefined()
    expect(await sw.fetchEvent('/', { headers: { upgrade: 'websocket' } })).toBeUndefined()
    expect(
      await sw.fetchEvent('/', { headers: { authorization: 'Bearer credential' } }),
    ).toBeUndefined()
    expect(
      await sw.fetchEvent('/assets/index-CxQ32zAz.js', { headers: { range: 'bytes=0-20' } }),
    ).toBeUndefined()
    expect(sw.network).not.toHaveBeenCalled()
    expect(sw.stores.size).toBe(0)
  })
  it('fetches actual HTML fresh and stores only the canonical public shell', async () => {
    const sw = worker()
    sw.network.mockResolvedValueOnce(html('first')).mockResolvedValueOnce(html('second'))
    expect(await (await sw.fetchEvent('/', {}, true))?.text()).toBe('first')
    expect(
      await (await sw.fetchEvent('/?view=projects&session=private-id', {}, true))?.text(),
    ).toBe('second')
    expect(sw.network).toHaveBeenCalledTimes(2)
    expect([...sw.stores.get('ari-mobile-v5-shell')!.keys()]).toEqual([origin + '/'])
    expect(
      await sw.stores
        .get('ari-mobile-v5-shell')!
        .get(origin + '/')!
        .text(),
    ).toBe('second')
    expect(await sw.fetchEvent('/unknown-api')).toBeUndefined()
  })
  it('never stores JSON, missing MIME, private, no-store, varied, opaque, redirected or failed shells', async () => {
    const sw = worker()
    const opaque = html('opaque')
    Object.defineProperty(opaque, 'type', { value: 'opaque' })
    const redirected = html('redirected')
    Object.defineProperty(redirected, 'redirected', { value: true })
    const responses = [
      Response.json({ secret: 'account' }),
      new Response('missing MIME'),
      html('private', { 'cache-control': 'public, private' }),
      html('no-store', { 'cache-control': 'NO-STORE' }),
      html('varied', { vary: 'Accept-Encoding, Cookie' }),
      opaque,
      redirected,
      new Response('unavailable', { status: 503 }),
      new Response('partial HTML', { status: 206, headers: { 'content-type': 'text/html' } }),
    ]
    for (const response of responses) {
      sw.network.mockResolvedValueOnce(response)
      await sw.fetchEvent('/', {}, true)
    }
    expect(sw.write).not.toHaveBeenCalled()
  })
  it('uses only a verified shell from its own cache when offline, never another app cache', async () => {
    const sw = worker()
    await (await sw.storage.open('another-app')).put('/', html('foreign user'))
    sw.network.mockRejectedValue(new Error('offline'))
    expect((await sw.fetchEvent('/', {}, true))?.type).toBe('error')
    await (
      await sw.storage.open('ari-mobile-v5-shell')
    ).put('/', html('private user', { 'cache-control': 'private' }))
    expect((await sw.fetchEvent('/', {}, true))?.type).toBe('error')
    await (await sw.storage.open('ari-mobile-v5-shell')).put('/', html('public offline shell'))
    expect(await (await sw.fetchEvent('/?view=now', {}, true))?.text()).toBe('public offline shell')
    expect(sw.stores.get('ari-mobile-v5-shell')!.size).toBe(1)
  })
  it('caches hashed public build assets and serves them without another network request', async () => {
    const sw = worker()
    const path = '/assets/index-CxQ32zAz.js'
    expect(await (await sw.fetchEvent(path))?.text()).toBe('bundle')
    expect(await (await sw.fetchEvent(path))?.text()).toBe('bundle')
    expect(sw.network).toHaveBeenCalledTimes(1)
    expect(await sw.fetchEvent('/assets/index.js')).toBeUndefined()
    expect(await sw.fetchEvent(path + '?token=secret')).toBeUndefined()
    expect(await sw.fetchEvent('/sw.js')).toBeUndefined()
  })
  it('does not cache build assets with private/no-store/missing public headers or wrong MIME', async () => {
    const sw = worker()
    for (const headers of [
      { 'content-type': 'text/javascript', 'cache-control': 'no-cache' },
      { 'content-type': 'text/javascript', 'cache-control': 'public, private' },
      { 'content-type': 'text/javascript', 'cache-control': 'public, no-store' },
      { 'content-type': 'text/html', 'cache-control': 'public' },
      { 'content-type': 'application/json', 'cache-control': 'public' },
    ]) {
      sw.network.mockResolvedValueOnce(new Response('uncacheable', { headers }))
      await sw.fetchEvent('/assets/private-CxQ32zAz.js')
    }
    expect(sw.write).not.toHaveBeenCalled()
  })
  it('caches module-fetch CORS responses only when their response URL is pinned to this origin', async () => {
    const sw = worker()
    const path = '/assets/module-CxQ32zAz.js'
    const module = new Response('module', {
      headers: { 'content-type': 'text/javascript', 'cache-control': 'public, immutable' },
    })
    Object.defineProperties(module, { type: { value: 'cors' }, url: { value: origin + path } })
    sw.network.mockResolvedValueOnce(module)
    expect(await (await sw.fetchEvent(path))?.text()).toBe('module')
    expect(sw.write).toHaveBeenCalledTimes(1)
    for (const responseUrl of ['', 'https://other.example/assets/module-CxQ32zAz.js']) {
      const rejected = new Response('untrusted', {
        headers: { 'content-type': 'text/javascript', 'cache-control': 'public, immutable' },
      })
      Object.defineProperties(rejected, { type: { value: 'cors' }, url: { value: responseUrl } })
      sw.network.mockResolvedValueOnce(rejected)
      await sw.fetchEvent('/assets/rejected-CxQ32zAz.js')
    }
    expect(sw.write).toHaveBeenCalledTimes(1)
  })
  it('finishes a cache write within the response promise instead of extending a fetch event after async work', async () => {
    const sw = worker()
    let release = () => {}
    const writing = new Promise<void>((resolve) => {
      release = resolve
    })
    let persisted = false
    sw.write.mockImplementationOnce(async () => {
      await writing
      persisted = true
    })
    let replied = false
    const result = sw.fetchEvent('/assets/lazy-CxQ32zAz.js').then((response) => {
      replied = true
      return response
    })
    await vi.waitFor(() => expect(sw.write).toHaveBeenCalledTimes(1))
    expect(replied).toBe(false)
    release()
    expect(await (await result)?.text()).toBe('bundle')
    expect(persisted).toBe(true)
  })
  it('applies response privacy checks during installation, and cache failures do not hide network results', async () => {
    const sw = worker()
    sw.network.mockResolvedValue(html('private shell', { 'cache-control': 'private' }))
    await sw.dispatch('install')
    expect(sw.write).not.toHaveBeenCalled()
    sw.network.mockResolvedValue(html('available online'))
    sw.write.mockRejectedValue(new Error('quota exceeded'))
    expect(await (await sw.fetchEvent('/'))?.text()).toBe('available online')
    expect(sw.warn).toHaveBeenCalledWith(
      'Ari could not store the offline app shell',
      expect.any(Error),
    )
  })
})
