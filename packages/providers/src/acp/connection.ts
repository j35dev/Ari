import type { Readable, Writable } from 'node:stream'
import { createLogger } from '@ari/shared/logger'
import { explainExitCode } from '../exit-codes'
import { spawnCli } from '../spawn-cli'
import {
  AUTH_REQUIRED_ERROR,
  describeAcpFailure,
} from './protocol'
import type {
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpRequestPermission,
  AcpSessionNotification,
} from './protocol'

const log = createLogger('providers:acp')

/** Launch description for an ACP agent subprocess. */
export interface AcpLaunch {
  /** Human-facing label for logs and errors. */
  label: string
  command: string
  args: string[]
  /** True when the agent rides `npx -y <pkg>` — enables npm exit decoding. */
  viaNpx?: boolean
}

/** Structural child surface the connection needs; real spawns satisfy it. */
export interface AcpChildProcess {
  stdin: Writable | null
  stdout: Readable
  stderr: Readable
  readonly killed: boolean
  kill(): boolean
  /** Subscribes to process-level failures (spawn ENOENT, EPIPE…). */
  on(event: 'error', listener: (error: Error) => void): unknown
  /** Optional exit subscription (`child.on('close', …)`); enables npm exit decoding. */
  onExit?(listener: (code: number | null) => void): unknown
}

export interface AcpConnectOptions {
  launch: AcpLaunch
  cwd: string
  clientName?: string
  clientVersion?: string
  /** Handshake ceiling; generous because npx adapters may download on first run. */
  initializeTimeoutMs?: number
  /** Client-side handler for `session/request_permission` server calls. */
  onRequestPermission?: (request: AcpRequestPermission) => Promise<unknown>
  /** Process factory seam for tests; defaults to the real Windows-safe spawner. */
  spawn?: (launch: AcpLaunch, cwd: string) => AcpChildProcess
}

export class AcpConnectionError extends Error {
  readonly code: number | null
  constructor(message: string, code: number | null = null) {
    super(message)
    this.name = 'AcpConnectionError'
    this.code = code
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  /** Silence watchdog interval; set only for long-lived turn requests. */
  stallTimer: ReturnType<typeof setInterval> | null
}

/**
 * Prompt-stall ceiling from `ARI_ACP_PROMPT_STALL_MS`: how long an agent may
 * stay completely silent mid-turn before its prompt fails legibly instead of
 * spinning forever (comet's wedge detection). Number in ms; 0 disables;
 * unset falls back to the 120s default.
 */
export function acpPromptStallMs(raw = process.env['ARI_ACP_PROMPT_STALL_MS']): number {
  if (raw === undefined || raw.trim() === '') return 120_000
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return 120_000
  return value
}

/**
 * One ACP agent subprocess speaking newline-delimited JSON-RPC 2.0 over
 * stdio (the protocol's stdio transport). Handles the initialize handshake,
 * request/response multiplexing, and routing of server→client calls
 * (permission requests; unadvertised fs/terminal/elicitation methods are
 * answered with method-not-found).
 */
export class AcpConnection {
  readonly #child: AcpChildProcess
  readonly #pending = new Map<number, PendingRequest>()
  readonly #closeWaiter: Promise<void>
  readonly #stderrTail: string[] = []
  #nextId = 1
  #closed = false
  /** Last inbound byte timestamp — liveness signal for the stall watchdog. */
  #lastInboundAt = Date.now()
  #exitCode: number | null = null

  launch: AcpLaunch
  initialize: AcpInitializeResult

  /** Hook for `session/update` notifications; assigned by the driver. */
  onSessionUpdate: ((notification: AcpSessionNotification) => void) | null = null

  /**
   * Hook answering server `session/request_permission` calls. Returning a
   * value resolves the agent's request with that outcome.
   */
  onRequestPermission: ((request: AcpRequestPermission) => Promise<unknown>) | null

  private constructor(
    child: AcpChildProcess,
    launch: AcpLaunch,
    onRequestPermission: ((request: AcpRequestPermission) => Promise<unknown>) | null,
    closeWaiter: Promise<void>,
  ) {
    this.#child = child
    this.launch = launch
    this.initialize = {}
    this.onRequestPermission = onRequestPermission
    this.#closeWaiter = closeWaiter
  }

  get closed(): boolean {
    return this.#closed
  }

  /**
   * Spawns the agent and completes the initialize handshake. Throws
   * AcpConnectionError on spawn failure, timeout, or a JSON-RPC error so the
   * caller can fall back to another transport.
   */
  static async connect(options: AcpConnectOptions): Promise<AcpConnection> {
    const { launch } = options
    let child: AcpChildProcess
    try {
      child =
        options.spawn !== undefined
          ? options.spawn(launch, options.cwd)
          : spawnCli(launch.command, launch.args, {
              cwd: options.cwd,
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
            })
      if (options.spawn === undefined) {
        // Adapt the real child_process surface to the exit hook.
        const real = child as AcpChildProcess & { on: (e: string, l: unknown) => unknown }
        real.onExit = (listener: (code: number | null) => void) => {
          real.on('close', (code: unknown) => listener(typeof code === 'number' ? code : null))
        }
      }
    } catch (error) {
      throw new AcpConnectionError(`${launch.label} failed to spawn: ${describeAcpFailure(error)}`)
    }

    child.stderr.setEncoding('utf8')

    const closeWaiter = new Promise<void>((resolveClose) => {
      // stdout close is the transport end for stdio JSON-RPC.
      child.stdout.once('close', () => resolveClose())
    })

    const connection = new AcpConnection(child, launch, options.onRequestPermission ?? null, closeWaiter)

    child.stderr.on('data', (chunk: string) => {
      if (connection.#stderrTail.length > 6) connection.#stderrTail.shift()
      connection.#stderrTail.push(chunk)
    })

    // Exit codes feed npm errno decoding in failure messages (comet #95).
    child.onExit?.((code: number | null) => {
      connection.#exitCode = code
    })

    // Spawn failures (missing binary, ENOENT) arrive asynchronously; without
    // this listener they crash the host as unhandled 'error' events.
    child.on('error', (error: Error) => {
      log.debug('acp: process error', { label: launch.label, error: error.message })
      connection.#failAllPending(new AcpConnectionError(`${launch.label} process error: ${error.message}`))
    })

    connection.#wireStdout()
    connection.#watchExit()

    try {
      const result = (await connection.#request(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: {
            name: options.clientName ?? 'ari',
            version: options.clientVersion ?? '0.1.0',
          },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            auth: { terminal: false },
          },
        },
        options.initializeTimeoutMs ?? 45_000,
      )) as AcpInitializeResult
      connection.initialize = result ?? {}
      return connection
    } catch (error) {
      connection.kill()
      const message = error instanceof Error ? error.message : String(error)
      throw new AcpConnectionError(
        `${launch.label} initialization failed: ${message}` +
          explainExitCode(connection.#exitCode, launch.viaNpx === true) +
          connection.#tailReport(),
        error instanceof AcpConnectionError ? error.code : null,
      )
    }
  }

  #tailReport(): string {
    const tail = this.#stderrTail.join('').trim().split('\n').slice(-3).join('\n')
    return tail.length > 0 ? `\n${tail}` : ''
  }

  #wireStdout(): void {
    let buffer = ''
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk: string) => {
      this.#lastInboundAt = Date.now()
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length > 0) this.#handleLine(line)
        index = buffer.indexOf('\n')
      }
    })
  }

  #watchExit(): void {
    this.#child.stdout.once('close', () => {
      this.#closed = true
      const exitDetail = explainExitCode(this.#exitCode, this.launch.viaNpx === true)
      this.#failAllPending(
        new AcpConnectionError(
          `${this.launch.label} exited mid-request${exitDetail}${this.#tailReport()}`,
        ),
      )
    })
  }

  #failAllPending(error: AcpConnectionError): void {
    for (const [id, pending] of this.#pending) {
      if (pending.timer !== null) clearTimeout(pending.timer)
      if (pending.stallTimer !== null) clearInterval(pending.stallTimer)
      pending.reject(error)
      this.#pending.delete(id)
    }
  }

  #handleLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      log.debug('acp: dropping non-JSON line', { line: line.slice(0, 200) })
      return
    }

    const hasId = message['id'] !== undefined && message['id'] !== null
    const method = typeof message['method'] === 'string' ? message['method'] : null

    if (method !== null && hasId) {
      // Server→client request.
      void this.#handleServerRequest(message['id'] as number, method, message['params'])
      return
    }
    if (method !== null) {
      if (method === 'session/update') {
        const params = message['params'] as AcpSessionNotification | undefined
        this.onSessionUpdate?.(params ?? {})
      }
      return
    }
    if (hasId) {
      const pending = this.#pending.get(message['id'] as number)
      if (!pending) return
      this.#pending.delete(message['id'] as number)
      if (pending.timer !== null) clearTimeout(pending.timer)
      if (pending.stallTimer !== null) clearInterval(pending.stallTimer)
      const error = message['error'] as { code?: number; message?: string } | undefined
      if (error !== undefined && error !== null) {
        // Auth walls can arrive on any method (session/prompt after token
        // expiry, not just session/new) — always swap in the actionable copy.
        if (error.code === AUTH_REQUIRED_ERROR) {
          pending.reject(
            new AcpConnectionError(
              `${this.launch.label} is not authenticated yet — run its login flow once in a terminal, then retry`,
              AUTH_REQUIRED_ERROR,
            ),
          )
        } else {
          pending.reject(new AcpConnectionError(error.message ?? 'agent error', error.code ?? null))
        }
      } else {
        pending.resolve(message['result'])
      }
    }
  }

  async #handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    if (method === 'session/request_permission' && this.onRequestPermission !== null) {
      try {
        const result = await this.onRequestPermission(params as AcpRequestPermission)
        this.#write({ jsonrpc: '2.0', id, result: result ?? { outcome: { outcome: 'cancelled' } } })
      } catch (error) {
        log.debug('acp: permission handler failed', { error: String(error) })
        this.#write({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: 'permission handler failed' },
        })
      }
      return
    }
    // fs/*, terminal/*, elicitation/* are not advertised by Ari's client
    // capabilities; agents must use their own local access instead.
    this.#write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `method not implemented by client: ${method}` },
    })
  }

  #write(message: Record<string, unknown>): boolean {
    const stdin = this.#child.stdin
    if (stdin === null || stdin.destroyed || stdin.writableEnded) return false
    stdin.write(`${JSON.stringify(message)}\n`)
    return true
  }

  #request(method: string, params: unknown, timeoutMs?: number, stallSilenceMs?: number): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new AcpConnectionError(`${this.launch.label} connection is closed`))
    }
    const id = this.#nextId++
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let stallTimer: ReturnType<typeof setInterval> | null = null
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.#pending.delete(id)
          if (timer !== null) clearTimeout(timer)
          if (stallTimer !== null) clearInterval(stallTimer)
          reject(
            new AcpConnectionError(`${this.launch.label}: ${method} timed out after ${timeoutMs}ms`),
          )
        }, timeoutMs)
        timer.unref?.()
      }
      if (stallSilenceMs !== undefined && stallSilenceMs > 0) {
        // Silence watchdog: any inbound traffic (updates, pings, partials)
        // proves liveness; total silence past the ceiling fails the request.
        const interval = setInterval(() => {
          if (Date.now() - this.#lastInboundAt < stallSilenceMs) return
          if (timer !== null) clearTimeout(timer)
          clearInterval(interval)
          this.#pending.delete(id)
          const quiet =
            stallSilenceMs < 1000
              ? `${stallSilenceMs}ms`
              : `${Math.round(stallSilenceMs / 1000)}s`
          reject(
            new AcpConnectionError(
              `${this.launch.label} went silent for ${quiet} mid-${method} — ` +
                `the agent may be wedged or waiting for login${this.#tailReport()}`,
            ),
          )
        }, Math.min(2000, Math.max(25, Math.floor(stallSilenceMs / 8))))
        interval.unref?.()
        stallTimer = interval
      }
      this.#pending.set(id, { resolve, reject, timer, stallTimer })
      if (!this.#write({ jsonrpc: '2.0', id, method, params })) {
        this.#pending.delete(id)
        if (timer !== null) clearTimeout(timer)
        if (stallTimer !== null) clearInterval(stallTimer)
        reject(new AcpConnectionError(`${this.launch.label} stdin unavailable`))
      }
    })
  }

  #notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  /** Creates a session bound to `cwd`; throws descriptive errors on auth walls. */
  async newSession(cwd: string): Promise<AcpNewSessionResult> {
    let result: unknown
    try {
      result = await this.#request('session/new', { cwd, mcpServers: [] }, 30_000)
    } catch (error) {
      if (error instanceof AcpConnectionError && error.code === AUTH_REQUIRED_ERROR) {
        throw new AcpConnectionError(
          `${this.launch.label} is not authenticated yet — run its login flow once in a terminal, then retry`,
          AUTH_REQUIRED_ERROR,
        )
      }
      throw error
    }
    const created = (result ?? {}) as AcpNewSessionResult
    if (typeof created.sessionId !== 'string') {
      throw new AcpConnectionError(`${this.launch.label} returned no sessionId`)
    }
    return created
  }

  /**
   * Resumes a persisted agent session by id (only call when initialize
   * advertised `agentCapabilities.loadSession`). The spec's response body is
   * empty; the agent re-attaches the given id and replays prior history as
   * session/update notifications, so allow a generous timeout.
   */
  async loadSession(sessionId: string, cwd: string): Promise<AcpNewSessionResult> {
    const result = await this.#request('session/load', { sessionId, cwd, mcpServers: [] }, 60_000)
    return { ...((result ?? {}) as AcpNewSessionResult), sessionId }
  }

  /**
   * Sends one user text prompt; resolves with the turn's stopReason. A
   * totally silent agent fails after `stallSilenceMs` (default from
   * {@link acpPromptStallMs}) instead of hanging the turn forever.
   */
  async prompt(
    sessionId: string,
    text: string,
    stallSilenceMs: number = acpPromptStallMs(),
  ): Promise<string> {
    const result = (await this.#request(
      'session/prompt',
      {
        sessionId,
        prompt: [{ type: 'text', text }],
      },
      undefined,
      stallSilenceMs,
    )) as { stopReason?: string } | null
    return typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn'
  }

  cancel(sessionId: string): void {
    this.#notify('session/cancel', { sessionId })
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<AcpNewSessionResult['configOptions']> {
    // Bounded so an agent that ignores the method cannot stall a turn setup.
    const result = (await this.#request(
      'session/set_config_option',
      { sessionId, configId, value },
      10_000,
    )) as { configOptions?: AcpNewSessionResult['configOptions'] } | null
    return result?.configOptions ?? null
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.#request('session/set_mode', { sessionId, modeId }, 10_000)
  }

  /** Resolves when the underlying process ends (or is killed). */
  waitClosed(): Promise<void> {
    return this.#closeWaiter
  }

  kill(): void {
    if (!this.#child.killed) this.#child.kill()
  }
}
