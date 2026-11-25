import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createLogger } from '@ari/shared/logger'
import { spawnCli } from '../spawn-cli'
import { OcHttp } from './http'
import type { OpencodeGeneration } from './version'
import type { OcEvent, OpencodeWire } from './wire'
import { WireV1 } from './wire-v1'
import { WireV2 } from './wire-v2'

const log = createLogger('providers:opencode-server')

/**
 * One `opencode serve` process per binary (and per environment it has to
 * carry), shared by every Ari session that talks to it. Sessions are
 * multiplexed over the server's single event stream, so a parked session costs
 * nothing, where ACP held a ~500 MB agent process for each one.
 */

/** Variables that differ per Ari session. OpenCode 2 receives them per session instead. */
export const SESSION_SCOPED_ENV = [
  'ARI_SESSION_ID',
  'ARI_PROJECT_ID',
  'ARI_PARENT_SESSION_ID',
  'ARI_CONTROL_TOKEN',
] as const

const PASSWORD_ENV = ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD'] as const

export interface ServerChild {
  pid?: number | undefined
  exitCode: number | null
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  stdin: { end(): void } | null
  once(event: 'exit', listener: (code: number | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export interface ServerSpec {
  binary: string
  generation: OpencodeGeneration
  /** The server's process environment. */
  env: Record<string, string | undefined>
}

export interface ServerPoolOptions {
  spawn?: (binary: string, args: string[], options: SpawnOptions) => ServerChild
  fetch?: typeof fetch
  /** How long an unused server lives on for the next turn. */
  idleMs?: number
  startTimeoutMs?: number
  killTree?: (pid: number) => Promise<void>
}

export function serverArgs(generation: OpencodeGeneration): string[] {
  // OpenCode 2's stdio mode prints its URL as one JSON line and exits when
  // stdin closes, so the server cannot outlive Ari even if Ari crashes.
  return generation === 'v2'
    ? ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0']
    : ['serve', '--hostname', '127.0.0.1', '--port', '0']
}

/** The server's URL from its startup output, or null while it has not said yet. */
export function readServerUrl(generation: OpencodeGeneration, stdout: string): string | null {
  if (generation === 'v1')
    return /opencode server listening on (https?:\/\/\S+)/.exec(stdout)?.[1] ?? null
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue
    try {
      const url = (JSON.parse(line) as { url?: unknown }).url
      if (typeof url === 'string') return url.replace(/\/+$/, '')
    } catch {
      // A partial line; wait for the rest.
    }
  }
  return null
}

/** What both generations' variables look like without per-session values. */
export function serverEnvironment(spec: ServerSpec): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...spec.env }
  for (const key of PASSWORD_ENV) delete env[key]
  if (spec.generation === 'v2') for (const key of SESSION_SCOPED_ENV) delete env[key]
  return env
}

export class OpencodeServer {
  readonly #listeners = new Set<(event: OcEvent) => void>()
  readonly #closedListeners = new Set<(reason: string) => void>()
  #closed = false
  #stopping: Promise<void> | null = null
  #subscription: { close: () => void } | null = null
  refs = 0
  idleTimer: NodeJS.Timeout | null = null

  constructor(
    readonly spec: ServerSpec,
    readonly http: OcHttp,
    readonly wire: OpencodeWire,
    private readonly child: ServerChild,
    private readonly killTree: (pid: number) => Promise<void>,
  ) {
    child.once('exit', (code) => this.#markClosed(`OpenCode server exited (code ${code})`))
  }

  get closed(): boolean {
    return this.#closed
  }

  /** Opens the event stream; resolves once it is live. */
  async listen(): Promise<void> {
    const subscription = this.http.subscribe(
      this.wire.eventPath,
      (payload) => {
        for (const event of this.wire.normalize(payload))
          for (const listener of [...this.#listeners]) listener(event)
      },
      {
        onReconnect: () =>
          log.warn('OpenCode event stream reconnected; events in the gap were lost', {
            binary: this.spec.binary,
          }),
      },
    )
    this.#subscription = subscription
    await subscription.ready
  }

  on(listener: (event: OcEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  onClosed(listener: (reason: string) => void): () => void {
    this.#closedListeners.add(listener)
    return () => this.#closedListeners.delete(listener)
  }

  #markClosed(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    this.#subscription?.close()
    for (const listener of [...this.#closedListeners]) listener(reason)
  }

  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      const exited = new Promise<void>((resolve) => {
        if (this.child.exitCode !== null) resolve()
        else this.child.once('exit', () => resolve())
      })
      this.#markClosed('OpenCode server stopped')
      this.child.stdin?.end()
      const wait = (ms: number) =>
        Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(r, ms, false))])
      // OpenCode 2 exits on stdin EOF. The classic server does not, and on
      // Windows only a tree kill reaches the binary behind its npm shim.
      if (await wait(this.spec.generation === 'v2' ? 3000 : 200)) return
      if (this.child.pid !== undefined)
        await this.killTree(this.child.pid).catch((error: unknown) =>
          log.warn('OpenCode server tree kill failed', { error: String(error) }),
        )
      await wait(3000)
    })()
    return this.#stopping
  }
}

export class OpencodeServerPool {
  readonly #servers = new Map<string, Promise<OpencodeServer>>()
  readonly #options: Required<Omit<ServerPoolOptions, 'fetch'>> & { fetch?: typeof fetch }

  constructor(options: ServerPoolOptions = {}) {
    this.#options = {
      spawn: options.spawn ?? ((binary, args, opts) => spawnCli(binary, args, opts)),
      idleMs: options.idleMs ?? 10 * 60_000,
      startTimeoutMs: options.startTimeoutMs ?? 60_000,
      killTree: options.killTree ?? defaultKillTree,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }
  }

  static key(spec: ServerSpec): string {
    const env = serverEnvironment(spec)
    return JSON.stringify([
      spec.binary,
      spec.generation,
      Object.keys(env)
        .filter((key) => env[key] !== undefined)
        .sort()
        .map((key) => [key, env[key]]),
    ])
  }

  /**
   * A running server for `spec`, started on first use. Pair with {@link release}.
   * With `anyEnvironment`, a server already running for the same binary is
   * reused whatever variables it carries: right for read-only calls such as
   * catalogs, which should not start a second server beside a session's.
   */
  async acquire(
    spec: ServerSpec,
    options: { anyEnvironment?: boolean } = {},
  ): Promise<OpencodeServer> {
    if (options.anyEnvironment) {
      for (const pending of this.#servers.values()) {
        const running = await pending.catch(() => null)
        if (
          running !== null &&
          !running.closed &&
          running.spec.binary === spec.binary &&
          running.spec.generation === spec.generation
        ) {
          running.refs++
          if (running.idleTimer) {
            clearTimeout(running.idleTimer)
            running.idleTimer = null
          }
          return running
        }
      }
    }
    const key = OpencodeServerPool.key(spec)
    let pending = this.#servers.get(key)
    if (pending) {
      const existing = await pending.catch(() => null)
      if (existing === null || existing.closed) {
        if (this.#servers.get(key) === pending) this.#servers.delete(key)
        pending = undefined
      }
    }
    if (!pending) {
      pending = this.#start(spec)
      this.#servers.set(key, pending)
      pending.catch(() => {
        if (this.#servers.get(key) === pending) this.#servers.delete(key)
      })
    }
    const server = await pending
    server.refs++
    if (server.idleTimer) {
      clearTimeout(server.idleTimer)
      server.idleTimer = null
    }
    return server
  }

  release(server: OpencodeServer): void {
    server.refs = Math.max(0, server.refs - 1)
    if (server.refs > 0 || server.closed) return
    server.idleTimer = setTimeout(() => {
      if (server.refs > 0) return
      const key = OpencodeServerPool.key(server.spec)
      void this.#servers.get(key)?.then((current) => {
        if (current === server) this.#servers.delete(key)
      })
      void server.stop()
    }, this.#options.idleMs)
    server.idleTimer.unref?.()
  }

  /** Servers currently running or starting. */
  get size(): number {
    return this.#servers.size
  }

  async shutdownAll(): Promise<void> {
    const servers = [...this.#servers.values()]
    this.#servers.clear()
    await Promise.all(
      servers.map((pending) => pending.then((server) => server.stop()).catch(() => {})),
    )
  }

  async #start(spec: ServerSpec): Promise<OpencodeServer> {
    const password = randomBytes(24).toString('base64url')
    const env = {
      ...serverEnvironment(spec),
      [spec.generation === 'v2' ? 'OPENCODE_PASSWORD' : 'OPENCODE_SERVER_PASSWORD']: password,
    }
    const child = this.#options.spawn(spec.binary, serverArgs(spec.generation), {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    log.info('OpenCode server starting', { generation: spec.generation, pid: child.pid })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    const url = await new Promise<string>((resolve, reject) => {
      let stdout = ''
      let settled = false
      const timer = setTimeout(() => {
        fail(new Error(`OpenCode server did not start within ${this.#options.startTimeoutMs} ms`))
      }, this.#options.startTimeoutMs)
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (child.pid !== undefined) void this.#options.killTree(child.pid).catch(() => {})
        reject(error)
      }
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout = (stdout + chunk.toString()).slice(-8000)
        const found = readServerUrl(spec.generation, stdout)
        if (found !== null && !settled) {
          settled = true
          clearTimeout(timer)
          resolve(found)
        }
      })
      child.once('error', (error) => fail(error))
      child.once('exit', (code) =>
        fail(
          new Error(
            `OpenCode server exited before it was ready (code ${code})${stderr ? `: ${stderr.trim().slice(-500)}` : ''}`,
          ),
        ),
      )
    })
    const http = new OcHttp({
      url,
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
    })
    const wire = spec.generation === 'v2' ? new WireV2(http) : new WireV1(http)
    const server = new OpencodeServer(spec, http, wire, child, this.#options.killTree)
    try {
      await server.listen()
    } catch (error) {
      await server.stop()
      throw error
    }
    log.info('OpenCode server ready', { generation: spec.generation, url })
    return server
  }
}

function defaultKillTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const taskkill = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
      taskkill.once('exit', () => resolve())
      taskkill.once('error', reject)
      return
    }
    try {
      process.kill(pid, 'SIGTERM')
      setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
        resolve()
      }, 1500).unref?.()
    } catch {
      resolve()
    }
  })
}
