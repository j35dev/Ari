import type { AgentEvent } from '@ari/contracts/agent-event'
import type { ClaudeControlProcess } from './claude-driver'

interface Entry {
  key: string
  process: ClaudeControlProcess
}

/** Park native stream-json processes so Claude's built-in agents survive replies. */
export class ClaudeSessionPool {
  readonly #idle = new Map<string, Entry>()
  readonly #releases = new Set<Promise<void>>()
  #timer: ReturnType<typeof setInterval> | null = null
  onBackground: ((sessionId: string, events: AgentEvent[]) => void) | null = null
  onEnded: ((sessionId: string) => void | Promise<void>) | null = null

  constructor(
    private readonly idleMs = 30 * 60_000,
    private readonly maxIdle = 12,
  ) {}

  take(sessionId: string, key: string, resumeOf: string | null): ClaudeControlProcess | null {
    const entry = this.#idle.get(sessionId)
    if (!entry) return null
    this.#idle.delete(sessionId)
    this.#disarmWhenEmpty()
    entry.process.onEnded = null
    // A reset has no resume ref and must not reuse the old conversation.
    if (
      entry.process.closed ||
      entry.key !== key ||
      !resumeOf ||
      entry.process.sessionRef !== resumeOf
    ) {
      void entry.process.shutdown()
      return null
    }
    return entry.process
  }

  put(sessionId: string, key: string, process: ClaudeControlProcess): boolean {
    if (process.closed) return false
    void this.release(sessionId)
    const entry = { key, process }
    this.#idle.set(sessionId, entry)
    process.onEnded = () => {
      if (this.#idle.get(sessionId) !== entry) return
      this.#idle.delete(sessionId)
      this.#disarmWhenEmpty()
      void this.onEnded?.(sessionId)
    }
    process.onBackground = (events) => this.onBackground?.(sessionId, events)
    while (this.#idle.size > this.maxIdle) {
      const idle = [...this.#idle].find(([, entry]) => !entry.process.hasRunningTasks)
      if (!idle) break
      void this.release(idle[0])
    }
    this.#timer ??= setInterval(() => this.reap(), 60_000)
    this.#timer.unref?.()
    return this.has(sessionId)
  }

  has(sessionId: string): boolean {
    return this.#idle.get(sessionId)?.process.closed === false
  }

  release(sessionId: string): Promise<void> {
    const entry = this.#idle.get(sessionId)
    if (!entry) return Promise.resolve()
    this.#idle.delete(sessionId)
    entry.process.onBackground = null
    entry.process.onEnded = null
    const ended = this.onEnded?.(sessionId)
    const release = Promise.all([entry.process.shutdown(), ended]).then(() => undefined)
    this.#releases.add(release)
    void release.finally(() => this.#releases.delete(release))
    this.#disarmWhenEmpty()
    return release
  }

  #disarmWhenEmpty(): void {
    if (this.#idle.size === 0 && this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  reap(now = Date.now()): void {
    for (const [id, entry] of this.#idle) {
      if (!entry.process.hasRunningTasks && now - entry.process.lastActivity >= this.idleMs)
        void this.release(id)
    }
  }

  async shutdownAll(): Promise<void> {
    const entries = [...this.#idle.values()]
    this.#idle.clear()
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await Promise.all(
      entries.map(({ process }) => {
        process.onBackground = null
        process.onEnded = null
        return process.shutdown()
      }),
    )
    await Promise.all(this.#releases)
  }
}

export const claudeSessionPool = new ClaudeSessionPool()
