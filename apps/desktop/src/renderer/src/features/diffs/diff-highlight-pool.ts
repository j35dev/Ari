import { createLogger } from '@ari/shared/logger'

const log = createLogger('ui:diff-highlight')
export interface HighlightLine {
  key: string
  side: 'old' | 'new'
  text: string
}
export interface HighlightRequest {
  id: number
  lang: string
  lines: HighlightLine[]
}
export interface HighlightReply {
  id: number
  html: Record<string, string>
  error?: string
}

/** One lazy worker shared by visible diff surfaces, with bounded requests and idle disposal. */
export class DiffHighlightPool {
  #worker: Worker | null = null
  #id = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  readonly #pending = new Map<number, (html: Record<string, string>) => void>()
  constructor(
    readonly createWorker = () =>
      new Worker(new URL('./diff-highlight.worker.ts', import.meta.url), { type: 'module' }),
    readonly idleMs = 30_000,
  ) {}

  request(
    lang: string,
    lines: HighlightLine[],
  ): { promise: Promise<Record<string, string>>; cancel: () => void } {
    const id = ++this.#id
    const promise = new Promise<Record<string, string>>((resolve) => {
      if (this.#pending.size >= 8) {
        const oldest = this.#pending.keys().next().value!
        this.#pending.get(oldest)?.({})
        this.#pending.delete(oldest)
      }
      this.#pending.set(id, resolve)
      try {
        if (!this.#worker) {
          this.#worker = this.createWorker()
          this.#worker.onmessage = (event: MessageEvent<HighlightReply>) => {
            if (event.data.error)
              log.warn('Diff highlighting unavailable', { error: event.data.error })
            this.#pending.get(event.data.id)?.(event.data.html)
            this.#pending.delete(event.data.id)
            if (!this.#pending.size) this.#idle()
          }
          this.#worker.onerror = () => {
            log.warn('Diff highlighting worker failed')
            this.dispose()
          }
        }
        this.#worker.postMessage({ id, lang, lines } satisfies HighlightRequest)
        this.#idle()
      } catch (error) {
        log.warn('Diff worker could not start', { error: String(error) })
        this.dispose()
      }
    })
    return {
      promise,
      cancel: () => {
        this.#pending.get(id)?.({})
        this.#pending.delete(id)
        if (!this.#pending.size) this.#idle()
      },
    }
  }

  #idle(): void {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.dispose(), this.idleMs)
  }

  /** Releases the worker and resolves abandoned work as immediately usable plain text. */
  dispose(): void {
    clearTimeout(this.#timer)
    this.#worker?.terminate()
    this.#worker = null
    for (const resolve of this.#pending.values()) resolve({})
    this.#pending.clear()
  }
}
