import { OcHttp } from '../http'

export interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

/**
 * An OcHttp over a fake fetch that records each request and answers from
 * `routes` (`'METHOD /path'` → JSON body, a Response, or a function of the
 * call count returning either). Unrouted calls get 204.
 */
/** A fetch input as a URL string. */
export function href(url: string | URL | Request): string {
  return typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
}

export function fakeHttp(routes: Record<string, unknown> = {}) {
  const requests: RecordedRequest[] = []
  const calls = new Map<string, number>()
  const http = new OcHttp({
    url: 'http://127.0.0.1:9',
    authorization: 'Basic test',
    fetch: (url, init) => {
      const parsed = new URL(href(url))
      const method = init?.method ?? 'GET'
      const path = parsed.pathname
      requests.push({
        method,
        path,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      })
      const key = `${method} ${path}`
      const route = routes[key]
      calls.set(key, (calls.get(key) ?? 0) + 1)
      const answer =
        typeof route === 'function' ? (route as (n: number) => unknown)(calls.get(key)!) : route
      if (answer instanceof Response) return Promise.resolve(answer)
      if (answer === undefined) return Promise.resolve(new Response(null, { status: 204 }))
      return Promise.resolve(new Response(JSON.stringify(answer)))
    },
  })
  return { http, requests }
}
