import type { Readable, Writable } from 'node:stream'
import { createLogger } from '@ari/shared/logger'
import { explainExitCode } from '../exit-codes'
import { spawnCli } from '../spawn-cli'
import { teardownChild } from '../teardown'
import {
  AUTH_REQUIRED_ERROR,
  describeAcpFailure,
  terminalLoginsFrom,
} from './protocol'
import { isInteractiveClientMethod } from './client-requests'
import type {
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpRequestPermission,
  AcpSessionNotification,
  AcpTerminalLogin,
} from './protocol'

const log = createLogger('providers:acp')

/** The ACP major version every message Ari sends is shaped for. */
export const ACP_PROTOCOL_VERSION = 1

/** How long the stdio transport's own EOF gets before the ladder escalates. */
const TRANSPORT_EOF_GRACE_MS = 400
/** How long SIGTERM gets before the process tree is killed outright. */
const TRANSPORT_TERM_GRACE_MS = 600

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
  kill(signal?: NodeJS.Signals): boolean
  /** Subscribes to process-level failures (spawn ENOENT, EPIPE…). */
  on(event: 'error', listener: (error: Error) => void): unknown
  /** Optional exit subscription (`child.on('close', …)`); enables npm exit decoding. */
  onExit?(listener: (code: number | null) => void): unknown
  /** Optional: real spawns carry one, and the teardown ladder needs it to
   * reach grandchildren (`npx` → node → the agent → its own tools). */
  pid?: number | undefined
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

/**
 * The agent refused a request until its own login runs (`authRequired`,
 * -32000). Carries the logins the agent advertised at initialize so the caller
 * can offer them instead of telling the user to go find a terminal. `logins`
 * is empty when the agent offered nothing Ari can launch.
 */
export class AcpAuthRequiredError extends AcpConnectionError {
  readonly logins: AcpTerminalLogin[]
  constructor(message: string, logins: AcpTerminalLogin[]) {
    super(message, AUTH_REQUIRED_ERROR)
    this.name = 'AcpAuthRequiredError'
    this.logins = logins
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
 * unset falls back to the 300s default. The ceiling is generous on purpose:
 * agents can be legitimately — and detectably — silent for minutes (Claude's
 * adapter emits no session/update while it compacts a long conversation),
 * and only a true wedge has neither inbound traffic nor a pending
 * server→client request to explain the quiet.
 */
export function acpPromptStallMs(raw = process.env['ARI_ACP_PROMPT_STALL_MS']): number {
  if (raw === undefined || raw.trim() === '') return 300_000
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return 300_000
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
  /**
   * Server→client requests the agent is still waiting on an answer for.
   * Silence while this is > 0 means the agent is parked on the user (a
   * permission prompt, a question, a plan approval) — not that it is wedged —
   * so the stall watchdog must not fail the turn no matter how long the user
   * takes to answer.
   */
  #pendingServerRequests = 0

  launch: AcpLaunch
  initialize: AcpInitializeResult

  /** Hook for `session/update` notifications; assigned by the driver. */
  onSessionUpdate: ((notification: AcpSessionNotification) => void) | null = null

  /**
   * Hook answering server `session/request_permission` calls. Returning a
   * value resolves the agent's request with that outcome.
   */
  onRequestPermission: ((request: AcpRequestPermission) => Promise<unknown>) | null

  /**
   * Hook answering interactive server→client methods Ari implements:
   * `elicitation/create`, `_x.ai/ask_user_question`, `_x.ai/exit_plan_mode`
   * (and the unprefixed `x.ai/` spellings). Unhandled methods still get
   * method-not-found.
   */
  onClientRequest: ((method: string, params: unknown) => Promise<unknown>) | null

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
    this.onClientRequest = null
    this.#closeWaiter = closeWaiter
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Logins the agent advertised at initialize that Ari can launch itself. */
  get terminalLogins(): AcpTerminalLogin[] {
    return terminalLoginsFrom(this.initialize, {
      command: this.launch.command,
      args: this.launch.args,
    })
  }

  /**
   * Wraps an `authRequired` refusal with the agent's own login options. Auth
   * walls arrive on any method — `session/prompt` after a token expires as
   * readily as `session/new` — so every rejection path funnels through here.
   */
  #authRequired(): AcpAuthRequiredError {
    const logins = this.terminalLogins
    const message =
      logins.length > 0
        ? `${this.launch.label} needs you to sign in again`
        : `${this.launch.label} is not authenticated yet — run its login flow once in a terminal, then retry`
    return new AcpAuthRequiredError(message, logins)
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
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientInfo: {
            name: options.clientName ?? 'ari',
            version: options.clientVersion ?? '0.1.0',
          },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            auth: { terminal: false },
            // Form elicitation is how Claude (and anyone else speaking ACP)
            // routes AskUserQuestion. Without this advertisement the adapter
            // disables the tool at session create and the model has nowhere
            // to put a question.
            elicitation: { form: {} },
            // Ari does not implement ACP's `terminal/*` methods, so it cannot
            // host the agent's login itself. The `terminal-auth` extension is
            // the metadata-only alternative: the agent answers with the exact
            // argv for each login, which Ari runs in its own terminal pane.
            // Without this flag agents advertise no auth methods at all and an
            // expired session can only ever fail.
            _meta: { 'terminal-auth': true },
          },
        },
        options.initializeTimeoutMs ?? 45_000,
      )) as AcpInitializeResult
      connection.initialize = result ?? {}
      // The agent answers with the version it will actually speak. Ari keeps
      // talking either way — every message it sends is v1-shaped and the
      // adapters downgrade rather than refuse — but a mismatch is the first
      // thing to look at when an agent's updates stop making sense.
      const negotiated = connection.initialize.protocolVersion
      if (typeof negotiated === 'number' && negotiated !== ACP_PROTOCOL_VERSION) {
        log.warn('acp: agent negotiated a different protocol version', {
          label: launch.label,
          requested: ACP_PROTOCOL_VERSION,
          negotiated,
        })
      }
      return connection
    } catch (error) {
      connection.kill()
      const message = error instanceof Error ? error.message : String(error)
      const detail =
        `${launch.label} initialization failed: ${message}` +
        explainExitCode(connection.#exitCode, launch.viaNpx === true) +
        connection.#tailReport()
      // An auth wall on the handshake itself predates any authMethods, so
      // there is nothing to offer — but the kind must survive so callers still
      // route it to the sign-in path rather than a generic transport failure.
      if (error instanceof AcpAuthRequiredError) throw new AcpAuthRequiredError(detail, error.logins)
      throw new AcpConnectionError(
        detail,
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
        if (error.code === AUTH_REQUIRED_ERROR) {
          pending.reject(this.#authRequired())
        } else {
          pending.reject(new AcpConnectionError(error.message ?? 'agent error', error.code ?? null))
        }
      } else {
        pending.resolve(message['result'])
      }
    }
  }

  async #handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    // Every path below answers the agent, but some only after the user acts
    // (permissions, questions, plan approvals park until responded). The
    // counter tells the stall watchdog the agent is waiting, not dead.
    this.#pendingServerRequests++
    try {
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
      if (this.onClientRequest !== null && isInteractiveClientMethod(method)) {
        try {
          const result = await this.onClientRequest(method, params)
          this.#write({ jsonrpc: '2.0', id, result: result ?? {} })
        } catch (error) {
          log.debug('acp: client request handler failed', { method, error: String(error) })
          this.#write({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: 'client request handler failed' },
          })
        }
        return
      }
      // fs/*, terminal/* are not advertised by Ari's client capabilities;
      // agents must use their own local access instead. Interactive methods
      // (elicitation / Grok ext) are handled above when the adapter hooked them.
      this.#write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not implemented by client: ${method}` },
      })
    } finally {
      this.#pendingServerRequests--
      // The exchange just advanced — the user answered and the agent has new
      // input. Restart the stall clock, or the watchdog would measure the
      // agent's next move against the whole time the user spent thinking,
      // and fail the turn the moment the parked request completes.
      this.#lastInboundAt = Date.now()
    }
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
        // proves liveness; total silence past the ceiling fails the request —
        // unless the agent is parked on an unanswered server→client request,
        // where the silence is Ari's user taking their time, not a wedge.
        const interval = setInterval(() => {
          if (Date.now() - this.#lastInboundAt < stallSilenceMs) return
          if (this.#pendingServerRequests > 0) return
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
    const result = await this.#request('session/new', { cwd, mcpServers: [] }, 30_000)
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
   *
   * Callers that already hold the transcript (Ari's journal) MUST NOT fold
   * those replay notifications into the new turn — attach `onSessionUpdate`
   * only after this promise resolves.
   */
  async loadSession(sessionId: string, cwd: string): Promise<AcpNewSessionResult> {
    const result = await this.#request('session/load', { sessionId, cwd, mcpServers: [] }, 60_000)
    return { ...((result ?? {}) as AcpNewSessionResult), sessionId }
  }

  /**
   * Restores session context without replaying history. Prefer this over
   * {@link loadSession} when the agent advertised `sessionCapabilities.resume`.
   */
  async resumeSession(sessionId: string, cwd: string): Promise<AcpNewSessionResult> {
    const result = await this.#request('session/resume', { sessionId, cwd, mcpServers: [] }, 60_000)
    return { ...((result ?? {}) as AcpNewSessionResult), sessionId }
  }

  /**
   * Sends one user prompt with optional staged images; resolves with the
   * turn's stopReason. A totally silent agent fails after `stallSilenceMs`
   * (default from {@link acpPromptStallMs}) instead of hanging the turn
   * forever.
   */
  async prompt(
    sessionId: string,
    text: string,
    options: { images?: { data: string; mimeType: string }[]; stallSilenceMs?: number } = {},
  ): Promise<string> {
    const { images = [], stallSilenceMs = acpPromptStallMs() } = options
    const blocks: { type: string; text?: string; data?: string; mimeType?: string }[] = []
    if (text.length > 0) blocks.push({ type: 'text', text })
    for (const image of images) {
      blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType })
    }
    const result = (await this.#request(
      'session/prompt',
      {
        sessionId,
        prompt: blocks,
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

  /**
   * Ends the agent for good, in escalating rungs: close stdin (the stdio
   * transport's own end-of-input), then hand off to the shared teardown ladder
   * (SIGTERM, then a tree kill).
   *
   * A bare `kill()` was not enough. An npx-launched adapter is the root of a
   * tree — `npx` → node → the adapter → the agent CLI it spawns → that agent's
   * own bash/powershell children — and on Windows a signal to the `.cmd` shim
   * reaches none of them, so every finished turn leaked the agent it had just
   * been talking to. `teardownChild` is the same ladder the legacy CLI drivers
   * dispose through; the ACP transport was the one path still skipping it.
   */
  async shutdown(): Promise<void> {
    const child = this.#child
    if (child.stdin !== null && !child.stdin.writableEnded) child.stdin.end()
    if (this.#closed) return
    if (await this.#closedWithin(TRANSPORT_EOF_GRACE_MS)) return
    await teardownChild(
      {
        pid: child.pid,
        exitCode: this.#exitCode,
        stdin: null,
        kill: (signal) => child.kill(signal),
        // stdout close is the transport end, so the close waiter is the
        // liveness signal the ladder should race its rungs against.
        once: (event, listener) => {
          if (event === 'close') void this.#closeWaiter.then(listener, listener)
        },
      },
      { eofGraceMs: 0, termGraceMs: TRANSPORT_TERM_GRACE_MS },
    )
  }

  /** True when the transport closed within `ms`. */
  async #closedWithin(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), ms)
      timer.unref?.()
    })
    try {
      return await Promise.race([this.#closeWaiter.then(() => true), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
