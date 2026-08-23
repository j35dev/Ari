import type { ChildProcess } from 'node:child_process'
import type { McpServerConfig } from './mcp-servers'
import { createLogger } from '@ari/shared/logger'
import { spawnCli } from '@ari/providers/spawn-cli'

const log = createLogger('ari-core:mcp')

/**
 * MCP client transport: JSON-RPC 2.0 over a server process's stdio as
 * newline-delimited JSON, per the Model Context Protocol stdio transport.
 */

/** Wire protocol version advertised during the initialize handshake. */
export const MCP_PROTOCOL_VERSION = '2024-11-05'

/** Wall-clock budget for the initialize handshake. */
export const MCP_INIT_TIMEOUT_MS = 10_000
/** Wall-clock budget for tools/list and tools/call requests. */
export const MCP_REQUEST_TIMEOUT_MS = 30_000
/** Stderr bytes retained per connection so failures carry a hint. */
const STDERR_TAIL_BYTES = 8 * 1024

interface JsonRpcErrorShape {
  code: number
  message: string
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type OutgoingMessage =
  | { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
  | { jsonrpc: '2.0'; method: string; params?: unknown }
  | { jsonrpc: '2.0'; id: number | string; error?: JsonRpcErrorShape; result?: unknown }

/** A tool advertised by an MCP server via tools/list. */
export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpConnectOptions {
  /** Initialize handshake budget; connect rejects past it. */
  timeoutMs?: number
  /** Per-request budget for tools/list and tools/call. */
  requestTimeoutMs?: number
  /** Working directory for the spawned server process. */
  cwd?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const record = asRecord(part)
    if (record && typeof record['text'] === 'string') parts.push(record['text'])
    else parts.push(JSON.stringify(part))
  }
  return parts.join('\n')
}

/**
 * One connection to one MCP server process: spawn, initialize handshake,
 * then tools/list / tools/call until disposed. Every request is bounded by
 * a timeout; spawn failures and premature exits reject in-flight work —
 * they never throw out of the caller's loop.
 */
export class McpConnection {
  readonly #child: ChildProcess
  readonly #requestTimeoutMs: number
  readonly #label: string
  readonly #pending = new Map<number, PendingRequest>()
  #nextId = 0
  #buffer = ''
  #stderrTail = ''
  #disposed = false

  private constructor(
    child: ChildProcess,
    options: { requestTimeoutMs: number; label: string },
  ) {
    this.#child = child
    this.#requestTimeoutMs = options.requestTimeoutMs
    this.#label = options.label

    child.stdout?.on('data', (chunk: Buffer) => this.#ingest(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.#absorbStderr(chunk))
    child.stdin?.on('error', (error: Error) => {
      log.debug('mcp stdin write failed', { server: this.#label, error: String(error) })
    })
    child.on('error', (error: Error) => {
      this.#fail(new Error(`mcp server '${this.#label}' failed to run: ${error.message}`))
    })
    child.on('close', (code: number | null) => {
      if (!this.#disposed) {
        this.#fail(
          new Error(`mcp server '${this.#label}' exited unexpectedly (code ${code ?? 'signal'})`),
        )
      }
    })
  }

  /**
   * Spawns the configured server and completes the MCP initialize
   * handshake. Rejects — killing the process — when the spawn fails or the
   * handshake exceeds its timeout budget.
   */
  static async connect(
    server: Pick<McpServerConfig, 'name' | 'command' | 'args' | 'env'>,
    options: McpConnectOptions = {},
  ): Promise<McpConnection> {
    const initTimeoutMs = options.timeoutMs ?? MCP_INIT_TIMEOUT_MS
    // Server env entries layer over the ambient environment: servers keep
    // PATH etc., explicit keys win.
    const child = spawnCli(server.command, server.args, {
      cwd: options.cwd,
      env: { ...process.env, ...server.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const connection = new McpConnection(child, {
      requestTimeoutMs: options.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS,
      label: server.name,
    })
    try {
      await connection.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ari-core', version: '0.1.0' },
        },
        initTimeoutMs,
      )
    } catch (error) {
      await connection.dispose()
      throw error
    }
    connection.notify('notifications/initialized')
    log.info('mcp server initialized', { server: server.name })
    return connection
  }

  /** Lists the tools the server advertises via tools/list. */
  async listTools(): Promise<McpToolInfo[]> {
    const result = asRecord(await this.request('tools/list', {}))
    const rawTools = Array.isArray(result?.['tools']) ? result?.['tools'] : []
    const tools: McpToolInfo[] = []
    for (const entry of rawTools ?? []) {
      const record = asRecord(entry)
      if (!record || typeof record['name'] !== 'string' || record['name'].length === 0) continue
      tools.push({
        name: record['name'],
        ...(typeof record['description'] === 'string'
          ? { description: record['description'] }
          : {}),
        ...(asRecord(record['inputSchema'])
          ? { inputSchema: record['inputSchema'] as Record<string, unknown> }
          : {}),
      })
    }
    return tools
  }

  /**
   * Calls one server tool and flattens its content parts into text.
   * Protocol failures and `isError` results both throw, so the agent loop
   * records an errored tool-completed instead of feeding a fake success
   * back to the model.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    let result: unknown
    try {
      result = await this.request('tools/call', { name, arguments: args })
    } catch (error) {
      throw new Error(
        `mcp tool '${name}' failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    const record = asRecord(result)
    const text = textFromContent(record?.['content'])
    if (record?.['isError'] === true) {
      throw new Error(text.length > 0 ? text : `mcp tool '${name}' reported an error`)
    }
    return text.length > 0 ? text : '(no output)'
  }

  /** Kills the server process and rejects every in-flight request. Idempotent. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#failAll(new Error(`mcp server '${this.#label}' was disposed`))
    // EOF on stdin lets well-behaved servers exit before the kill lands.
    this.#child.stdin?.end()
    this.#child.kill()
    if (this.#child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 1_000)
      timer.unref?.()
      this.#child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * Sends a request and resolves with its result. Bounded by `timeoutMs`
   * (default: the connection's request budget); rejects on timeout, JSON-RPC
   * error response, or connection failure.
   */
  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.#disposed) throw new Error(`mcp server '${this.#label}' is disposed`)
    const budget = timeoutMs ?? this.#requestTimeoutMs
    const id = ++this.#nextId
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new Error(`mcp request '${method}' timed out after ${budget}ms (${this.#stderrHint()})`),
        )
      }, budget)
      timer.unref?.()
      this.#pending.set(id, { method, resolve, reject, timer })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Fire-and-forget notification; never throws. */
  notify(method: string, params?: unknown): void {
    this.#send({ jsonrpc: '2.0', method, params })
  }

  #send(message: OutgoingMessage): void {
    if (this.#disposed) return
    try {
      this.#child.stdin?.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      log.debug('mcp write failed', { server: this.#label, error: String(error) })
    }
  }

  #ingest(chunk: Buffer): void {
    this.#buffer += chunk.toString('utf8')
    for (;;) {
      const newlineAt = this.#buffer.indexOf('\n')
      if (newlineAt === -1) break
      const line = this.#buffer.slice(0, newlineAt).trim()
      this.#buffer = this.#buffer.slice(newlineAt + 1)
      if (line.length > 0) this.#handleLine(line)
    }
  }

  #handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return // non-JSON stdout noise (banners, progress bars) is ignored
    }
    const record = asRecord(parsed)
    if (!record) return
    const id = record['id']
    if (typeof record['method'] === 'string') {
      // Server→client request (sampling, roots, …): not implemented — answer
      // with method-not-found so the server never hangs waiting on us.
      if (typeof id === 'number' || typeof id === 'string') {
        this.#send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'method not supported by ari-core' },
        })
      }
      return
    }
    if (typeof id !== 'number') return // notification or malformed
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    const rpcError = asRecord(record['error'])
    if (rpcError && typeof rpcError['message'] === 'string') {
      pending.reject(new Error(`mcp ${pending.method} failed: ${rpcError['message']}`))
    } else {
      pending.resolve(record['result'])
    }
  }

  #absorbStderr(chunk: Buffer): void {
    this.#stderrTail = (this.#stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
  }

  #stderrHint(): string {
    const hint = this.#stderrTail.trim().split('\n').at(-1)?.trim() ?? ''
    return hint.length > 0 ? `stderr: ${hint}` : 'no stderr output'
  }

  #fail(error: Error): void {
    log.warn(error.message)
    this.#failAll(error)
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}
