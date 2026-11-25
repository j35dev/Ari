import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpencodeServerPool,
  readServerUrl,
  serverArgs,
  serverEnvironment,
  type ServerChild,
} from './server'
import type { OcEvent } from './wire'
import { href } from './__fixtures__/fake-http'

class FakeChild extends EventEmitter implements ServerChild {
  pid = 4242
  exitCode: number | null = null
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdinEnded = false
  stdin = {
    end: () => {
      this.stdinEnded = true
      if (this.exitOnEof) this.exit(0)
    },
  }
  constructor(private readonly exitOnEof: boolean) {
    super()
  }
  exit(code: number) {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.emit('exit', code)
  }
}

/** A fetch whose event stream stays open and can be fed by the test. */
function eventFetch() {
  const encoder = new TextEncoder()
  let push: (data: unknown) => void = () => {}
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    if (!href(url).includes('event')) return new Response('{}')
    return new Response(
      new ReadableStream({
        start(controller) {
          push = (data) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        },
      }),
    )
  })
  return { fetch, push: (data: unknown) => push(data) }
}

const pools: OpencodeServerPool[] = []
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdownAll()))
})

function setup(generation: 'v1' | 'v2', announce: (child: FakeChild) => void) {
  const children: { child: FakeChild; args: string[]; options: SpawnOptions }[] = []
  const killTree = vi.fn(async (pid: number) => {
    children.find((entry) => entry.child.pid === pid)?.child.exit(1)
  })
  const events = eventFetch()
  const pool = new OpencodeServerPool({
    spawn: (_binary, args, options) => {
      const child = new FakeChild(generation === 'v2')
      children.push({ child, args, options })
      queueMicrotask(() => announce(child))
      return child
    },
    fetch: events.fetch,
    idleMs: 20,
    startTimeoutMs: 2000,
    killTree,
  })
  pools.push(pool)
  return { pool, children, killTree, events }
}

describe('server handshake', () => {
  it('reads both generations’ startup lines', () => {
    expect(
      readServerUrl('v1', 'Warning\nopencode server listening on http://127.0.0.1:4096\n'),
    ).toBe('http://127.0.0.1:4096')
    expect(readServerUrl('v2', '{"url":"http://127.0.0.1:5000/"}\n')).toBe('http://127.0.0.1:5000')
    expect(readServerUrl('v2', '{"url":"http://127.0')).toBeNull()
    expect(serverArgs('v2')).toContain('--stdio')
    expect(serverArgs('v1')).not.toContain('--stdio')
  })

  it('keeps per-session variables out of a shared OpenCode 2 server', () => {
    const env = { PATH: 'p', ARI_SESSION_ID: 's', ARI_CONTROL_TOKEN: 't', OPENCODE_PASSWORD: 'x' }
    expect(serverEnvironment({ binary: 'b', generation: 'v2', env })).toEqual({ PATH: 'p' })
    // The classic server has no per-session environment, so it keeps them.
    expect(serverEnvironment({ binary: 'b', generation: 'v1', env })).toEqual({
      PATH: 'p',
      ARI_SESSION_ID: 's',
      ARI_CONTROL_TOKEN: 't',
    })
  })

  it('starts OpenCode 2 over stdio with a generated password and shares it across sessions', async () => {
    const { pool, children, events } = setup('v2', (child) =>
      child.stdout.write('{"url":"http://127.0.0.1:5000"}\n'),
    )
    const spec = (session: string) => ({
      binary: 'opencode2',
      generation: 'v2' as const,
      env: { PATH: 'p', ARI_SESSION_ID: session },
    })
    const [a, b] = await Promise.all([pool.acquire(spec('one')), pool.acquire(spec('two'))])
    expect(a).toBe(b)
    expect(children).toHaveLength(1)
    const env = children[0]!.options.env as Record<string, string>
    expect(env['OPENCODE_PASSWORD']).toMatch(/^[\w-]{20,}$/)
    expect(env['ARI_SESSION_ID']).toBeUndefined()
    const seen: OcEvent[] = []
    a.on((event) => seen.push(event))
    events.push({ type: 'session.idle', data: { sessionID: 'ses_1' } })
    events.push({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } })
    await vi.waitFor(() =>
      expect(seen).toEqual([{ type: 'idle', sessionID: 'ses_1', outcome: 'completed' }]),
    )
    expect(events.fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from(`opencode:${env['OPENCODE_PASSWORD']}`).toString('base64')}`,
    })
  })

  it('stops an idle server after the last release; OpenCode 2 exits on stdin EOF', async () => {
    const { pool, children, killTree } = setup('v2', (child) =>
      child.stdout.write('{"url":"http://127.0.0.1:5000"}\n'),
    )
    const server = await pool.acquire({ binary: 'b', generation: 'v2', env: {} })
    pool.release(server)
    await vi.waitFor(() => expect(children[0]!.child.exitCode).toBe(0))
    expect(children[0]!.child.stdinEnded).toBe(true)
    expect(killTree).not.toHaveBeenCalled()
    expect(server.closed).toBe(true)
    // The next turn starts a fresh one.
    const next = await pool.acquire({ binary: 'b', generation: 'v2', env: {} })
    expect(next).not.toBe(server)
    expect(children).toHaveLength(2)
  })

  it('kills the classic server’s process tree on shutdown', async () => {
    const { pool, children, killTree } = setup('v1', (child) =>
      child.stdout.write('opencode server listening on http://127.0.0.1:4096\n'),
    )
    await pool.acquire({ binary: 'opencode.cmd', generation: 'v1', env: {} })
    expect(children[0]!.args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '0'])
    expect(
      (children[0]!.options.env as Record<string, string>)['OPENCODE_SERVER_PASSWORD'],
    ).toBeTruthy()
    await pool.shutdownAll()
    expect(killTree).toHaveBeenCalledWith(4242)
  })

  it('separates classic servers whose environments differ', async () => {
    const { pool, children } = setup('v1', (child) =>
      child.stdout.write('opencode server listening on http://127.0.0.1:4096\n'),
    )
    const a = await pool.acquire({ binary: 'b', generation: 'v1', env: { ARI_SESSION_ID: '1' } })
    const b = await pool.acquire({ binary: 'b', generation: 'v1', env: { ARI_SESSION_ID: '2' } })
    expect(a).not.toBe(b)
    expect(children).toHaveLength(2)
  })

  it('lets read-only callers reuse a running server whatever its environment', async () => {
    const { pool, children } = setup('v1', (child) =>
      child.stdout.write('opencode server listening on http://127.0.0.1:4096\n'),
    )
    const session = await pool.acquire({
      binary: 'b',
      generation: 'v1',
      env: { ARI_SESSION_ID: '1' },
    })
    const probe = await pool.acquire(
      { binary: 'b', generation: 'v1', env: {} },
      { anyEnvironment: true },
    )
    expect(probe).toBe(session)
    expect(session.refs).toBe(2)
    const other = await pool.acquire(
      { binary: 'other', generation: 'v1', env: {} },
      { anyEnvironment: true },
    )
    expect(other).not.toBe(session)
    expect(children).toHaveLength(2)
  })

  it('reports a server that exits before it is ready, with its stderr', async () => {
    const { pool } = setup('v2', (child) => {
      child.stderr.write('database is locked')
      setTimeout(() => child.exit(3), 5)
    })
    await expect(pool.acquire({ binary: 'b', generation: 'v2', env: {} })).rejects.toThrow(
      /exited before it was ready \(code 3\): database is locked/,
    )
    expect(pool.size).toBe(0)
  })

  it('tells listeners when the server dies', async () => {
    const { pool, children } = setup('v2', (child) =>
      child.stdout.write('{"url":"http://127.0.0.1:5000"}\n'),
    )
    const server = await pool.acquire({ binary: 'b', generation: 'v2', env: {} })
    const closed = vi.fn()
    server.onClosed(closed)
    children[0]!.child.exit(9)
    expect(closed).toHaveBeenCalledWith('OpenCode server exited (code 9)')
  })
})
