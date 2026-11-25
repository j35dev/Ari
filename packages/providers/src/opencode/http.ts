import { createLogger } from '@ari/shared/logger'

const log = createLogger('providers:opencode-http')

/**
 * A minimal JSON + SSE client for the OpenCode servers, typed from their
 * OpenAPI documents rather than generated: the driver uses a dozen calls, and
 * neither official client bundles cleanly (the classic SDK carries a process
 * spawner; OpenCode 2's client is built on Effect).
 */

export class OcHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    path: string,
  ) {
    super(`OpenCode ${path} answered ${status}${body ? `: ${body.slice(0, 300)}` : ''}`)
    this.name = 'OcHttpError'
  }
}

export interface OcHttpTarget {
  url: string
  /** Value of the Authorization header. */
  authorization: string
  fetch?: typeof fetch
}

export interface OcRequest {
  /** The project directory the call acts in; both generations read this header. */
  directory?: string
  body?: unknown
  query?: Record<string, string>
  timeoutMs?: number
}

export class OcHttp {
  readonly #fetch: typeof fetch
  constructor(readonly target: OcHttpTarget) {
    this.#fetch = target.fetch ?? fetch
  }

  #headers(directory: string | undefined, json: boolean): Record<string, string> {
    return {
      authorization: this.target.authorization,
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}),
    }
  }

  /** Resolves the parsed body (null when empty); throws {@link OcHttpError} on non-2xx. */
  async request<T = unknown>(method: string, path: string, init: OcRequest = {}): Promise<T> {
    const query = init.query ? `?${new URLSearchParams(init.query).toString()}` : ''
    const response = await this.#fetch(`${this.target.url}${path}${query}`, {
      method,
      headers: this.#headers(init.directory, init.body !== undefined),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    })
    const text = await response.text()
    if (!response.ok) throw new OcHttpError(response.status, text, path)
    if (text.length === 0) return null as T
    try {
      return JSON.parse(text) as T
    } catch {
      return text as T
    }
  }

  /**
   * A reconnecting SSE subscription. `ready` settles once the first stream is
   * open: OpenCode's event streams are live-only, so a prompt sent before then
   * could finish unseen. `onReconnect` reports a gap in which events may have
   * been missed.
   */
  subscribe(
    path: string,
    onData: (payload: unknown) => void,
    hooks: { onReconnect?: () => void; retryMs?: number } = {},
  ): { ready: Promise<void>; close: () => void } {
    let closed = false
    let controller: AbortController | null = null
    let markReady: () => void = () => {}
    let failReady: (error: unknown) => void = () => {}
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      failReady = reject
    })
    // Unobserved when the owner only needs the stream; never an unhandled rejection.
    ready.catch(() => {})
    let opened = false
    const run = async (): Promise<void> => {
      let attempt = 0
      while (!closed) {
        controller = new AbortController()
        try {
          const response = await this.#fetch(`${this.target.url}${path}`, {
            headers: { ...this.#headers(undefined, false), accept: 'text/event-stream' },
            signal: controller.signal,
          })
          if (!response.ok || response.body === null)
            throw new OcHttpError(response.status, await response.text().catch(() => ''), path)
          if (opened) hooks.onReconnect?.()
          opened = true
          attempt = 0
          markReady()
          const parse = createSseParser((data) => {
            try {
              onData(JSON.parse(data))
            } catch (error) {
              log.debug('unparseable OpenCode event', { error: String(error) })
            }
          })
          const decoder = new TextDecoder()
          const reader = response.body.getReader()
          while (!closed) {
            const chunk = (await reader.read()) as { value?: Uint8Array; done: boolean }
            if (chunk.done) break
            parse(decoder.decode(chunk.value, { stream: true }))
          }
        } catch (error) {
          if (closed) return
          if (!opened && attempt >= 2) {
            failReady(error)
            return
          }
          log.debug('OpenCode event stream dropped', { error: String(error) })
        }
        attempt++
        if (closed) return
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min((hooks.retryMs ?? 250) * 2 ** attempt, 5000)),
        )
      }
    }
    void run()
    return {
      ready,
      close: () => {
        closed = true
        controller?.abort()
        failReady(new Error('event stream closed'))
      },
    }
  }
}

/**
 * Incremental `text/event-stream` parser: feeds each complete event's joined
 * `data:` lines to `onEvent`. Comments (`: heartbeat`) and other fields are
 * dropped; events without data are skipped.
 */
export function createSseParser(onEvent: (data: string) => void): (chunk: string) => void {
  let buffer = ''
  let data: string[] = []
  return (chunk) => {
    buffer += chunk
    let newline = buffer.search(/\r\n|\r|\n/)
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      const width = buffer.startsWith('\r\n', newline) ? 2 : 1
      buffer = buffer.slice(newline + width)
      if (line.length === 0) {
        if (data.length > 0) onEvent(data.join('\n'))
        data = []
      } else if (line.startsWith('data:')) {
        data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
      }
      newline = buffer.search(/\r\n|\r|\n/)
    }
  }
}
