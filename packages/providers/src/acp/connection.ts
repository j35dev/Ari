import type { Readable, Writable } from 'node:stream'
import { createLogger } from '@ari/shared/logger'
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
  #nextId = 1
  #closed = false

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
    } catch (error) {
      throw new AcpConnectionError(`${launch.label} failed to spawn: ${describeAcpFailure(error)}`)
    }

    const stderrTail: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail.push(chunk)
      while (stderrTail.length > 6) stderrTail.shift()
    })

    const tailReport = (): string => {
      const tail = stderrTail.join('').trim().split('\n').slice(-3).join('\n')
      return tail.length > 0 ? `\n${tail}` : ''
    }

    const closeWaiter = new Promise<void>((resolveClose) => {
      // stdout close is the transport end for stdio JSON-RPC.
      child.stdout.once('close', () => resolveClose())
    })

    const connection = new AcpConnection(child, launch, options.onRequestPermission ?? null, closeWaiter)

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
        `${launch.label} initialization failed: ${message}${tailReport()}`,
        error instanceof AcpConnectionError ? error.code : null,
      )
    }
  }

  #wireStdout(): void {
    let buffer = ''
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk: string) => {
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
      this.#failAllPending(new AcpConnectionError(`${this.launch.label} exited mid-request`))
    })
  }

  #failAllPending(error: AcpConnectionError): void {
    for (const [id, pending] of this.#pending) {
      if (pending.timer !== null) clearTimeout(pending.timer)
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
      const error = message['error'] as { code?: number; message?: string } | undefined
      if (error !== undefined && error !== null) {
        pending.reject(new AcpConnectionError(error.message ?? 'agent error', error.code ?? null))
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

  #request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new AcpConnectionError(`${this.launch.label} connection is closed`))
    }
    const id = this.#nextId++
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(
            new AcpConnectionError(`${this.launch.label}: ${method} timed out after ${timeoutMs}ms`),
          )
        }, timeoutMs)
        timer.unref?.()
      }
      this.#pending.set(id, { resolve, reject, timer })
      if (!this.#write({ jsonrpc: '2.0', id, method, params })) {
        this.#pending.delete(id)
        if (timer !== null) clearTimeout(timer)
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

  /** Sends one user text prompt; resolves with the turn's stopReason. */
  async prompt(sessionId: string, text: string): Promise<string> {
    const result = (await this.#request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    })) as { stopReason?: string } | null
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
