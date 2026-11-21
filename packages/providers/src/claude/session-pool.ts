import type { AgentEvent } from '@ari/contracts/agent-event'
import type { ClaudeSessionProcess } from './session'

interface Entry {
  key: string
  process: ClaudeSessionProcess
}

/** Park Claude queries so native agents survive replies; pending work prevents reaping. */
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

  take(sessionId: string, key: string, resumeOf: string | null): ClaudeSessionProcess | null {
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
      this.#track(entry.process.shutdown())
      return null
    }
    return entry.process
  }

  put(sessionId: string, key: string, process: ClaudeSessionProcess): boolean {
    if (process.closed) return false
    void this.release(sessionId)
    const entry = { key, process }
    this.#idle.set(sessionId, entry)
    process.onEnded = () => {
      if (this.#idle.get(sessionId) !== entry) return
      this.#idle.delete(sessionId)
      this.#track(process.shutdown())
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
  hasTransport(sessionId: string, transport: 'sdk' | 'cli'): boolean {
    const process = this.#idle.get(sessionId)?.process
    return !!process && !process.closed && process.transport === transport
  }

  /** Stops a parked query's native subagents; its conversation stays open. */
  stopSubagents(sessionId: string): number {
    const process = this.#idle.get(sessionId)?.process
    return process && !process.closed ? (process.stopSubagents?.() ?? 0) : 0
  }

  controls(sessionId: string): ClaudeSessionProcess | null {
    const process = this.#idle.get(sessionId)?.process
    return process && !process.closed && process.hasPendingResponses !== false ? process : null
  }

  /** Pending work on a parked process must drain before an updater closes it. */
  hasBackgroundWork(sessionId: string): boolean {
    const process = this.#idle.get(sessionId)?.process
    return process !== undefined && !process.closed && process.hasRunningTasks
  }

  release(sessionId: string): Promise<void> {
    const entry = this.#idle.get(sessionId)
    if (!entry) return Promise.resolve()
    this.#idle.delete(sessionId)
    entry.process.onBackground = null
    entry.process.onEnded = null
    const ended = this.onEnded?.(sessionId)
    const release = Promise.all([entry.process.shutdown(), ended]).then(() => undefined)
    this.#track(release)
    this.#disarmWhenEmpty()
    return release
  }

  #track(release: Promise<void>): void {
    this.#releases.add(release)
    const finished = (): void => {
      this.#releases.delete(release)
    }
    void release.then(finished, finished)
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
