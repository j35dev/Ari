import type { AgentEvent } from '@ari/contracts/agent-event'
import type { PermissionMode } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import type { AcpConnection } from './connection'
import type { AcpConfigOption, AcpRequestPermission, AcpUpdateFolder } from './protocol'

const log = createLogger('providers:acp-pool')

/** An idle connection with no activity this long is closed. */
const IDLE_MS = 30 * 60_000
/** Idle connections kept at once; the least recently active close first. */
const MAX_IDLE = 12
const REAP_EVERY_MS = 60_000

/**
 * One agent process and its open ACP session, kept between turns of the same
 * Ari session. Keeping it alive is what lets the agent's background shells and
 * sub-agents outlive the turn that started them, and it saves every later turn
 * the process start, handshake and session reload.
 */
export interface PooledAcpSession {
  /** Launch fingerprint: a turn may only reuse a connection started the same way. */
  key: string
  connection: AcpConnection
  /** The agent's own session id. */
  sessionId: string
  folder: AcpUpdateFolder
  selectors: { configOptions: AcpConfigOption[]; availableModes: { id?: string; name?: string }[] }
  /** What was last applied to the agent session, so a later turn re-sends only changes. */
  applied: { modelId: string | null; permissionMode: PermissionMode; effort: string | null }
  lastActivity: number
}

export interface IdleHandlers {
  /** Answers a permission request that arrives with no turn to show it in. */
  onRequestPermission: (request: AcpRequestPermission) => Promise<unknown>
}

/**
 * Agent connections parked between turns, keyed by Ari session id. Updates
 * that arrive while parked (a background task reporting back) go to
 * {@link onBackground} so the host can record them.
 */
export class AcpSessionPool {
  readonly #idle = new Map<string, PooledAcpSession>()
  readonly #closing = new Map<string, Promise<void>>()
  #timer: ReturnType<typeof setInterval> | null = null
  /** Receives events an agent emits between turns, folded like a turn's. */
  onBackground: ((ariSessionId: string, events: AgentEvent[]) => void) | null = null
  /**
   * A parked connection went away (idle close, release, eviction, crash), and
   * with it whatever the agent still ran in the background. Not called when a
   * turn takes the connection back, nor on app quit.
   */
  onEnded: ((ariSessionId: string) => void | Promise<void>) | null = null

  constructor(
    private readonly idleMs = IDLE_MS,
    private readonly maxIdle = MAX_IDLE,
  ) {}

  /** The parked connection for this session when it is alive and launched the same way. */
  take(ariSessionId: string, key: string): PooledAcpSession | null {
    const entry = this.#idle.get(ariSessionId)
    if (!entry) return null
    this.#idle.delete(ariSessionId)
    if (entry.connection.closed) return null
    if (entry.key !== key) {
      log.info('agent launch changed; starting a fresh connection', { ariSessionId })
      void entry.connection.shutdown()
      return null
    }
    return entry
  }

  /** Parks a connection after its turn, routing its between-turn traffic. */
  put(ariSessionId: string, entry: PooledAcpSession, handlers: IdleHandlers): void {
    const previous = this.#idle.get(ariSessionId)
    if (previous && previous !== entry) void previous.connection.shutdown()
    entry.lastActivity = Date.now()
    const connection = entry.connection
    connection.onSessionUpdate = (notification) => {
      if (this.#idle.get(ariSessionId) !== entry) return
      entry.lastActivity = Date.now()
      const events = entry.folder.foldBetweenTurns(notification)
      if (events.length > 0) this.onBackground?.(ariSessionId, events)
    }
    connection.onRequestPermission = handlers.onRequestPermission
    // Questions need someone to answer them; with no turn on screen, decline.
    connection.onClientRequest = () => Promise.resolve({ outcome: { outcome: 'cancelled' } })
    this.#idle.set(ariSessionId, entry)
    void connection.waitClosed().then(() => {
      if (this.#idle.get(ariSessionId) !== entry) return
      this.#idle.delete(ariSessionId)
      return this.#ended(ariSessionId)
    })
    this.#evict()
    this.#arm()
  }

  /** Whether a connection is parked for this session. */
  has(ariSessionId: string): boolean {
    const entry = this.#idle.get(ariSessionId)
    return entry !== undefined && !entry.connection.closed
  }

  /** Ends a session's parked connection, when it is deleted or archived. */
  async release(ariSessionId: string): Promise<void> {
    const closing = this.#closing.get(ariSessionId)
    if (closing) return closing
    const entry = this.#idle.get(ariSessionId)
    if (!entry) return
    await this.#close(ariSessionId, entry)
  }

  /** Ends every parked connection, for app quit. */
  async shutdownAll(): Promise<void> {
    const entries = [...this.#idle.values()]
    this.#idle.clear()
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await Promise.all([
      ...this.#closing.values(),
      ...entries.map((entry) => entry.connection.shutdown().catch(() => undefined)),
    ])
  }

  /** How many connections are parked (tests and diagnostics). */
  get size(): number {
    return this.#idle.size
  }

  /** Closes connections idle past the limit. Runs on a timer; exposed for tests. */
  reap(now = Date.now()): void {
    for (const [id, entry] of this.#idle) {
      if (now - entry.lastActivity < this.idleMs) continue
      log.info('closing idle agent connection', { ariSessionId: id })
      void this.#close(id, entry).catch((error: unknown) =>
        log.warn('idle agent shutdown failed', { ariSessionId: id, error: String(error) }),
      )
    }
  }

  async #close(ariSessionId: string, entry: PooledAcpSession): Promise<void> {
    this.#idle.delete(ariSessionId)
    // The process is gone either way, so its background work ends even when
    // shutdown reports a failure.
    const task = entry.connection.shutdown().finally(() => this.#ended(ariSessionId))
    this.#closing.set(ariSessionId, task)
    try {
      await task
    } finally {
      if (this.#closing.get(ariSessionId) === task) this.#closing.delete(ariSessionId)
    }
  }

  async #ended(ariSessionId: string): Promise<void> {
    try {
      await this.onEnded?.(ariSessionId)
    } catch (error) {
      log.warn('onEnded handler failed', { ariSessionId, error: String(error) })
    }
  }

  #evict(): void {
    while (this.#idle.size > this.maxIdle) {
      let oldest: [string, PooledAcpSession] | null = null
      for (const pair of this.#idle)
        if (!oldest || pair[1].lastActivity < oldest[1].lastActivity) oldest = pair
      if (!oldest) return
      void this.#close(oldest[0], oldest[1]).catch((error: unknown) =>
        log.warn('evicted agent shutdown failed', { error: String(error) }),
      )
    }
  }

  #arm(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => {
      this.reap()
      if (this.#idle.size === 0 && this.#timer) {
        clearInterval(this.#timer)
        this.#timer = null
      }
    }, REAP_EVERY_MS)
    this.#timer.unref?.()
  }
}

/** The process-wide pool every ACP driver parks into. */
export const acpSessionPool = new AcpSessionPool()
