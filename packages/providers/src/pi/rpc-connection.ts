import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnCli } from '../spawn-cli'
import { teardownChild } from '../teardown'

export type PiRecord = Record<string, unknown> & { type: string }
export type PiSpawn = typeof spawnCli
export interface PiConnectionOptions {
  spawn?: PiSpawn
  /** Opt-in diagnostic sink. Prompt/tool data is never logged by default. */
  trace?: (direction: 'stdin' | 'stdout' | 'stderr', data: unknown) => void
}

/** A negative acknowledgement, distinct from an uncertain transport failure. */
export class PiCommandError extends Error {}

/** Pi's documented JSONL protocol. Subscribe before writing: a local turn can finish immediately. */
export class PiRpcConnection {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<
    string,
    {
      command: string
      resolve: (data: unknown) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  readonly #listeners = new Set<(record: PiRecord) => void>()
  readonly #failures = new Set<(error: Error) => void>()
  #seq = 0
  #buffer = ''
  #stderr = ''
  #failure: Error | null = null
  #disposal: Promise<void> | null = null
  bridgeReady = false

  constructor(
    binary: string,
    args: string[],
    private readonly options: PiConnectionOptions & {
      cwd: string
      env?: Record<string, string | undefined>
    },
  ) {
    this.#child = (options.spawn ?? spawnCli)(binary, args, {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk: string) => {
      this.#buffer += chunk
      let end: number
      // readline also splits U+2028/U+2029 inside valid JSON strings.
      while ((end = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, end).replace(/\r$/, '')
        this.#buffer = this.#buffer.slice(end + 1)
        if (line.trim()) this.#line(line)
      }
    })
    this.#child.stdout.once('end', () => {
      // Let the close event supply the exit code if the child also exited.
      setImmediate(() => this.#fail(new Error(`Pi RPC stdout closed.${this.#stderrSuffix()}`)))
    })
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4_000)
      options.trace?.('stderr', chunk)
    })
    this.#child.stdin.on('error', (error: Error) => this.#fail(error))
    this.#child.on('error', (error) => this.#fail(error))
    this.#child.on('close', (code, signal) =>
      this.#fail(
        new Error(
          `Pi RPC exited before completing the operation (code=${code}, signal=${signal}).${this.#stderrSuffix()}`,
        ),
      ),
    )
  }

  get closed(): boolean {
    return this.#failure !== null || this.#disposal !== null
  }

  #stderrSuffix(): string {
    const detail = this.#stderr.trim()
    return detail ? ` ${detail}` : ''
  }

  subscribe(listener: (record: PiRecord) => void, failure: (error: Error) => void): () => void {
    this.#listeners.add(listener)
    this.#failures.add(failure)
    if (this.#failure) failure(this.#failure)
    return () => {
      this.#listeners.delete(listener)
      this.#failures.delete(failure)
    }
  }

  #line(line: string): void {
    let record: PiRecord
    try {
      const parsed: unknown = JSON.parse(line)
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof (parsed as PiRecord).type !== 'string'
      )
        throw new Error('Expected a protocol object with a type.')
      record = parsed as PiRecord
    } catch (error) {
      this.#fail(new Error(`Invalid Pi RPC record: ${String(error)}`))
      return
    }
    this.options.trace?.('stdout', record)
    if (
      record.type === 'extension_ui_request' &&
      record.method === 'notify' &&
      record.message === 'ARI_PI_BRIDGE_READY'
    )
      this.bridgeReady = true
    if (record.type === 'response') {
      const pending = typeof record.id === 'string' ? this.#pending.get(record.id) : undefined
      const error = typeof record.error === 'string' ? record.error : 'command failed'
      if (!pending) {
        const command = typeof record.command === 'string' ? record.command : 'protocol'
        if (record.id === undefined && record.success === false)
          this.#fail(new Error(`Pi RPC ${command}: ${error}`))
        return
      }
      clearTimeout(pending.timer)
      this.#pending.delete(record.id as string)
      if (record.command !== pending.command || typeof record.success !== 'boolean') {
        pending.reject(new Error(`Invalid Pi RPC response for ${pending.command}.`))
      } else if (!record.success) {
        pending.reject(new PiCommandError(`Pi RPC ${pending.command}: ${error}`))
      } else pending.resolve(record.data)
      return
    }
    for (const listener of this.#listeners) listener(record)
  }

  #fail(error: Error): void {
    if (this.#failure) return
    this.#failure = error
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    if (this.#disposal === null) for (const failure of this.#failures) failure(error)
  }

  request(
    command: string,
    fields: Record<string, unknown> = {},
    timeoutMs = 45_000,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(this.#failure ?? new Error('Pi RPC is disposed.'))
    const id = `ari-pi-${++this.#seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Pi RPC ${command} acknowledgement timed out; delivery is uncertain.`))
      }, timeoutMs)
      this.#pending.set(id, { command, resolve, reject, timer })
      this.write({ ...fields, type: command, id }).catch((error) => {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** Stream callbacks honor backpressure and report asynchronous write failures. */
  write(record: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.reject(this.#failure ?? new Error('Pi RPC is disposed.'))
    this.options.trace?.('stdin', record)
    return new Promise((resolve, reject) => {
      this.#child.stdin.write(JSON.stringify(record) + '\n', (error) =>
        error ? reject(error) : resolve(),
      )
    })
  }

  dispose(): Promise<void> {
    this.#disposal ??= teardownChild(this.#child)
    this.#fail(new Error('Pi RPC is disposed.'))
    return this.#disposal
  }
}
