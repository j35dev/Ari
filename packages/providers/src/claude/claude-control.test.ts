import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeControlAdapter, ControlProcessLike } from './claude-driver'
import { buildInterruptFrame, buildUserFrame, wireClaudeControl } from './claude-driver'

class FakeChild extends EventEmitter implements ControlProcessLike {
  stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  killed = false
  /** Every JSON line written to stdin, verbatim including the trailing newline. */
  readonly lines: string[] = []

  constructor() {
    super()
    this.stdin = new PassThrough()
    this.stdin.on('data', (chunk: Buffer) => {
      this.lines.push(chunk.toString('utf8'))
    })
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
  }

  kill(): boolean {
    this.killed = true
    return true
  }
}

function harness(): { child: FakeChild; adapter: ClaudeControlAdapter } {
  const child = new FakeChild()
  return { child, adapter: wireClaudeControl(child) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('claude stdin control frames', () => {
  it('writes raw frames to stdin as newline-terminated JSON lines', () => {
    const { child, adapter } = harness()

    adapter.send({ foo: 'bar' })
    adapter.send({ baz: 1 })

    expect(child.lines).toEqual(['{"foo":"bar"}\n', '{"baz":1}\n'])
  })

  it('drops frames without throwing once the CLI has closed stdin', () => {
    const { child, adapter } = harness()

    child.stdin.destroy()
    adapter.send({ after: 'close' })

    expect(child.lines).toEqual([])
  })

  it('steer frame shape snapshot (exact stream-json input schema varies across claude versions)', () => {
    const { child, adapter } = harness()

    adapter.steer('focus on the parser module now')

    expect(child.lines).toHaveLength(1)
    expect(JSON.parse(child.lines.join(''))).toEqual(buildUserFrame('focus on the parser module now'))
    expect(child.lines.join('')).toMatchSnapshot()
  })

  it('respondApproval wraps allow/deny directives in the same user-turn shape (conservative stand-in for version-specific permission schemas)', () => {
    const { child, adapter } = harness()

    adapter.respondApproval('toolu_01', 'allow')
    adapter.respondApproval('toolu_02', 'deny')
    adapter.respondApproval('toolu_03', 'always-allow')

    expect(child.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      buildUserFrame('Approve tool use toolu_01.'),
      buildUserFrame('Deny tool use toolu_02.'),
      buildUserFrame('Always approve tool use toolu_03.'),
    ])
  })
})

describe('claude interrupt fallback', () => {
  it('sends the interrupt control frame first and defers the kill to the 2s fallback while the stream stays open', () => {
    vi.useFakeTimers()
    const { child, adapter } = harness()

    adapter.interrupt()

    expect(child.lines).toHaveLength(1)
    expect(JSON.parse(child.lines.join(''))).toEqual(buildInterruptFrame())
    expect(child.killed).toBe(false)

    vi.advanceTimersByTime(1999)
    expect(child.killed).toBe(false)

    vi.advanceTimersByTime(1)
    expect(child.killed).toBe(true)
  })

  it('cancels the kill fallback when the stream ends before the timer fires', () => {
    vi.useFakeTimers()
    const { child, adapter } = harness()

    adapter.interrupt()
    child.emit('close', 0)

    vi.advanceTimersByTime(10_000)
    expect(child.killed).toBe(false)
  })

  it('kills immediately instead of waiting out the timer when stdin is already gone', () => {
    vi.useFakeTimers()
    const { child, adapter } = harness()

    child.stdin.destroy()
    adapter.interrupt()

    expect(child.lines).toHaveLength(0)
    expect(child.killed).toBe(true)
  })

  it('ignores repeat interrupts while a fallback is already pending', () => {
    vi.useFakeTimers()
    const { child, adapter } = harness()

    adapter.interrupt()
    adapter.interrupt()

    expect(child.lines).toHaveLength(1)

    vi.advanceTimersByTime(2000)
    expect(child.killed).toBe(true)
  })

  it('dispose kills the process and clears any pending fallback timer', async () => {
    vi.useFakeTimers()
    const { child, adapter } = harness()

    adapter.interrupt()
    const disposed = adapter.dispose()

    // Dispose now runs the shared teardown ladder (EOF grace → SIGTERM), so
    // the kill lands inside a timer continuation rather than synchronously.
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(disposed).resolves.toBeUndefined()
    expect(child.killed).toBe(true)
  })
})
