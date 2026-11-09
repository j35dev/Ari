import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { AdapterSession, ProviderAdapter } from '../driver'
import { ClaudeDriver } from './claude-driver'
import { ClaudeSessionPool } from './session-pool'

class Child extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  exitCode: number | null = null
  sent: unknown[] = []
  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => this.sent.push(JSON.parse(chunk.toString('utf8'))))
    this.stdin.on('finish', () => this.close())
  }
  emitFrame(frame: unknown): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`)
  }
  close(code = 0): void {
    this.exitCode = code
    this.emit('close', code)
  }
  kill(): boolean {
    this.killed = true
    this.close()
    return true
  }
}

const SESSION: AdapterSession = {
  sessionId: 'ari',
  workspacePath: '/repo',
  prompt: 'Research',
  modelId: null,
  permissionMode: 'ask',
  resumeOf: null,
}
const pools: ClaudeSessionPool[] = []
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdownAll()))
})

function harness() {
  const pool = new ClaudeSessionPool(100, 2)
  pools.push(pool)
  const children: Child[] = []
  const driver = new ClaudeDriver('claude', {
    pool,
    spawn: () => {
      const child = new Child()
      children.push(child)
      return child
    },
  })
  return { pool, children, driver }
}
async function collect(adapter: ProviderAdapter): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of adapter.start()) events.push(event)
  return events
}
function spawnAgent(child: Child): void {
  child.emitFrame({ type: 'system', subtype: 'init', session_id: 'native' })
  child.emitFrame({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'call',
          name: 'Agent',
          input: { description: 'Read orchestration', run_in_background: true },
        },
      ],
    },
  })
  child.emitFrame({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task',
    tool_use_id: 'call',
    task_type: 'local_agent',
    is_backgrounded: true,
    description: 'Read orchestration',
  })
  child.emitFrame({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'Launched' }] },
  })
}
function finish(child: Child): void {
  child.emitFrame({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 } })
}

describe('Claude process continuity', () => {
  it('reports malformed task frames without crashing the persistent reader', async () => {
    const { driver, children } = harness()
    const adapter = await driver.create(SESSION)
    const events = collect(adapter)
    expect(() => children[0]!.emitFrame(null)).not.toThrow()
    finish(children[0]!)
    const received = await events
    expect(received.find((event) => event.type === 'error')?.message).toContain(
      'Invalid Claude stream message',
    )
    expect(received.at(-1)).toEqual({ type: 'done' })
    await adapter.dispose()
  })
  it('keeps agents alive after the main reply and delivers their progress and final report without a new prompt', async () => {
    const { driver, pool, children } = harness()
    const background = vi.fn<(sessionId: string, events: AgentEvent[]) => void>()
    pool.onBackground = background
    const adapter = await driver.create(SESSION)
    const events = collect(adapter)
    const child = children[0]!
    spawnAgent(child)
    finish(child)
    expect((await events).at(-1)?.type).toBe('done')
    await adapter.dispose()
    expect(adapter.keepsBackgroundWork?.()).toBe(true)
    expect(pool.has('ari')).toBe(true)
    expect(child.stdin.writableEnded).toBe(false)
    expect(adapter.steer?.('too late')).toBe(false)
    child.emitFrame({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'task',
      summary: 'Reading captains.ts',
    })
    child.emitFrame({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task',
      status: 'completed',
      summary: 'Mapped durable workflows',
    })
    child.emitFrame({
      type: 'stream_event',
      event: { delta: { type: 'text_delta', text: 'Both research reads finished.' } },
    })
    finish(child)
    await vi.waitFor(() =>
      expect(background.mock.calls.flatMap((call) => call[1])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'background-task',
            status: 'running',
            detail: 'Reading captains.ts',
          }),
          expect.objectContaining({
            type: 'background-task',
            status: 'completed',
            detail: 'Mapped durable workflows',
          }),
          { type: 'text-delta', text: 'Both research reads finished.' },
        ]),
      ),
    )
    expect(child.sent).toHaveLength(1)
  })

  it('reuses the same process and running task when the user sends another turn', async () => {
    const { driver, children } = harness()
    const first = await driver.create(SESSION)
    const firstEvents = collect(first)
    spawnAgent(children[0]!)
    finish(children[0]!)
    await firstEvents
    await first.dispose()
    const next = await driver.create({
      ...SESSION,
      prompt: 'Let me know when it is done',
      resumeOf: 'native',
    })
    expect(next.continuesBackgroundWork?.()).toBe(true)
    const nextEvents = collect(next)
    children[0]!.emitFrame({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task',
      status: 'failed',
      summary: 'Read failed',
    })
    finish(children[0]!)
    expect((await nextEvents).filter((event) => event.type === 'background-task')).toMatchObject([
      { id: 'call', status: 'running' },
      { id: 'call', status: 'failed' },
    ])
    await next.dispose()
    expect(children).toHaveLength(1)
    expect(children[0]!.stdout.listenerCount('data')).toBe(1)
    expect(children[0]!.sent).toHaveLength(2)
  })

  it('buffers completion reports arriving between result and disposal', async () => {
    const { driver, children, pool } = harness()
    const background = vi.fn<(sessionId: string, events: AgentEvent[]) => void>()
    pool.onBackground = background
    const first = await driver.create(SESSION)
    const events = collect(first)
    spawnAgent(children[0]!)
    finish(children[0]!)
    await events
    children[0]!.emitFrame({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task',
      status: 'completed',
      summary: 'Done',
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await first.dispose()
    expect(background.mock.calls.flatMap((call) => call[1])).toContainEqual(
      expect.objectContaining({ status: 'completed' }),
    )
  })

  it.each([
    { resumeOf: null },
    { resumeOf: 'different-thread' },
    { modelId: 'another-model' },
    { permissionMode: 'full' as const },
    { runtimeEnv: { CLAUDE_CONFIG_DIR: '/other-profile' } },
  ])('starts a fresh process after a reset or launch change: %j', async (change) => {
    const { driver, children } = harness()
    const first = await driver.create(SESSION)
    const events = collect(first)
    spawnAgent(children[0]!)
    finish(children[0]!)
    await events
    await first.dispose()
    const next = await driver.create({ ...SESSION, resumeOf: 'native', ...change })
    expect(next.continuesBackgroundWork?.()).toBe(false)
    expect(children).toHaveLength(2)
    const nextEvents = collect(next)
    finish(children[1]!)
    await nextEvents
    await next.dispose()
    await vi.waitFor(() => expect(children[0]!.stdin.writableEnded).toBe(true))
  })

  it('ends the process on Stop rather than parking interrupted native agents', async () => {
    const { driver, children, pool } = harness()
    const adapter = await driver.create(SESSION)
    const events = collect(adapter)
    spawnAgent(children[0]!)
    adapter.interrupt()
    finish(children[0]!)
    await events
    await adapter.dispose()
    expect(pool.has('ari')).toBe(false)
    expect(adapter.keepsBackgroundWork?.()).toBe(false)
    expect(children[0]!.stdin.writableEnded).toBe(true)
  })

  it('reports a parked process crash and releases archived or deleted sessions', async () => {
    const { driver, children, pool } = harness()
    const ended = vi.fn()
    pool.onEnded = ended
    const first = await driver.create(SESSION)
    const events = collect(first)
    spawnAgent(children[0]!)
    finish(children[0]!)
    await events
    await first.dispose()
    children[0]!.close(1)
    await vi.waitFor(() => expect(ended).toHaveBeenCalledWith('ari'))
    expect(pool.has('ari')).toBe(false)
    const second = await driver.create({ ...SESSION, resumeOf: 'native' })
    const secondEvents = collect(second)
    finish(children[1]!)
    await secondEvents
    await second.dispose()
    await pool.release('ari')
    expect(pool.has('ari')).toBe(false)
    expect(children[1]!.stdin.writableEnded).toBe(true)
  })

  it('does not reap a long-running native agent as an idle session', async () => {
    const { driver, children, pool } = harness()
    const first = await driver.create(SESSION)
    const events = collect(first)
    spawnAgent(children[0]!)
    finish(children[0]!)
    await events
    await first.dispose()
    pool.reap(Date.now() + 60_000)
    expect(pool.has('ari')).toBe(true)
    children[0]!.emitFrame({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task',
      status: 'completed',
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    pool.reap(Date.now() + 60_000)
    expect(pool.has('ari')).toBe(false)
  })

  it('awaits process and background cleanup when a parked connection is released', async () => {
    const { driver, children, pool } = harness()
    const adapter = await driver.create(SESSION)
    const events = collect(adapter)
    finish(children[0]!)
    await events
    await adapter.dispose()
    let finishCleanup!: () => void
    pool.onEnded = () =>
      new Promise<void>((resolve) => {
        finishCleanup = resolve
      })
    let released = false
    const releasing = pool.release('ari').then(() => {
      released = true
    })
    expect(pool.has('ari')).toBe(false)
    await Promise.resolve()
    expect(released).toBe(false)
    let stopped = false
    const shutdown = pool.shutdownAll().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    finishCleanup()
    await releasing
    await shutdown
    expect(released).toBe(true)
    expect(stopped).toBe(true)
  })
})
