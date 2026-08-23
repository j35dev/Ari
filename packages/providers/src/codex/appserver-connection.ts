import type { Readable, Writable } from 'node:stream'
import { createLogger } from '@ari/shared/logger'
import { spawnCli } from '../spawn-cli'

const log = createLogger('providers:codex')

/** Structural child surface; real spawns satisfy it, tests fake it. */
export interface CodexChildProcess {
  stdin: Writable | null
  stdout: Readable
  stderr: Readable
  readonly killed: boolean
  kill(): boolean
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface AppServerStartOptions {
  binaryPath: string
  cwd: string
  /** Process factory seam for tests; defaults to the Windows-safe spawner. */
  spawn?: (binaryPath: string, cwd: string) => CodexChildProcess
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * One `codex app-server` subprocess speaking newline-delimited JSON-RPC over
 * stdio (transport per `codex app-server --listen stdio://`). Frames follow
 * the shapes emitted by `codex app-server generate-json-schema`: client
 * requests carry `{id, method, params}` without a protocol-version field.
 *
 * Response frames are routed to `request()` callers internally; every other
 * frame (notifications, server→client requests) is forwarded verbatim to
 * {@linkcode onFrame} so the adapter owns all protocol semantics.
 */
export class AppServerConnection {
  readonly #child: CodexChildProcess
  readonly #pending = new Map<number, PendingRequest>()
  readonly #closeWaiter: Promise<void>
  #nextId = 1
  #closed = false

  /** Raw inbound frames that are not responses to client requests. */
  onFrame: ((line: string) => void) | null = null

  private constructor(child: CodexChildProcess, closeWaiter: Promise<void>) {
    this.#child = child
    this.#closeWaiter = closeWaiter
  }

  get closed(): boolean {
    return this.#closed
  }

  static start(options: AppServerStartOptions): AppServerConnection {
    let child: CodexChildProcess
    try {
      child =
        options.spawn !== undefined
          ? options.spawn(options.binaryPath, options.cwd)
          : spawnCli(options.binaryPath, ['app-server'], {
              cwd: options.cwd,
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
            })
    } catch (error) {
      // spawnCli throws synchronously only in exotic cases; normalize so the
      // driver's fallback path always sees an Error.
      throw new Error(`codex app-server failed to spawn: ${String(error)}`, { cause: error })
    }

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      log.debug('codex app-server stderr', { text: chunk.slice(0, 500) })
    })

    const closeWaiter = new Promise<void>((resolveClose) => {
      child.stdout.once('close', () => resolveClose())
    })
    const connection = new AppServerConnection(child, closeWaiter)

    // Spawn ENOENT/EPIPE arrive asynchronously; swallow into pending failure
    // instead of crashing the host as an unhandled 'error' event.
    child.on('error', (error: Error) => {
      log.debug('codex app-server process error', { error: error.message })
      connection.#failAllPending(new Error(`codex app-server process error: ${error.message}`))
    })

    child.stdout.setEncoding('utf8')
    let buffer = ''
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length > 0) connection.#handleLine(line)
        index = buffer.indexOf('\n')
      }
    })

    child.stdout.once('close', () => {
      connection.#closed = true
      connection.#failAllPending(new Error('codex app-server exited mid-request'))
    })

    return connection
  }

  /**
   * Sends one client request; rejects on error response, timeout, or a dead
   * transport. Bounded by construction so a silent server cannot stall turns.
   */
  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error('codex app-server connection is closed'))
    }
    const id = this.#nextId++
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(new Error(`codex app-server ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      }
      this.#pending.set(id, { resolve, reject, timer })
      if (!this.#write({ id, method, params })) {
        if (timer !== null) clearTimeout(timer)
        this.#pending.delete(id)
        reject(new Error('codex app-server stdin unavailable'))
      }
    })
  }

  /** Answers a server→client request by its wire id. */
  respond(id: number, result: unknown): void {
    this.#write({ id, result })
  }

  waitClosed(): Promise<void> {
    return this.#closeWaiter
  }

  kill(): void {
    if (!this.#child.killed) this.#child.kill()
  }

  #handleLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      log.debug('codex app-server: dropping non-JSON line', { line: line.slice(0, 200) })
      return
    }
    const hasId = message['id'] !== undefined && message['id'] !== null
    const isClientRequest = typeof message['method'] === 'string' && hasId

    if (hasId && !isClientRequest) {
      // Response frame: routed here, never surfaced to the adapter.
      const pending = this.#pending.get(message['id'] as number)
      if (!pending) return
      this.#pending.delete(message['id'] as number)
      if (pending.timer !== null) clearTimeout(pending.timer)
      const error = message['error'] as { code?: number; message?: string } | undefined
      if (error !== undefined && error !== null) {
        pending.reject(new Error(error.message ?? 'codex app-server rpc error'))
      } else {
        pending.resolve(message['result'])
      }
      return
    }
    this.onFrame?.(line)
  }

  #failAllPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      if (pending.timer !== null) clearTimeout(pending.timer)
      pending.reject(error)
      this.#pending.delete(id)
    }
  }

  #write(message: Record<string, unknown>): boolean {
    const stdin = this.#child.stdin
    if (stdin === null || stdin.destroyed || stdin.writableEnded) return false
    stdin.write(`${JSON.stringify(message)}\n`)
    return true
  }
}
