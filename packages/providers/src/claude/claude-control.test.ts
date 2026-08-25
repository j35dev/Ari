import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeControlAdapter, ControlProcessLike } from './claude-driver'
import {
  buildApprovalResponseFrame,
  buildInterruptFrame,
  buildUnsupportedControlResponse,
  buildUserFrame,
  wireClaudeControl,
} from './claude-driver'

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

function harness(options?: { initialPrompt?: unknown }): {
  child: FakeChild
  adapter: ClaudeControlAdapter
} {
  const child = new FakeChild()
  return { child, adapter: wireClaudeControl(child, options) }
}

/** Pulls once so the event pump attaches its stdout/stderr listeners. */
function startPump(adapter: ClaudeControlAdapter): void {
  const iterator = adapter.start()[Symbol.asyncIterator]()
  void iterator.next()
}

/** Writes one frame into the fake child's stdout as a JSONL line. */
function emitStdout(child: FakeChild, frame: unknown): void {
  ;(child.stdout as PassThrough).write(`${JSON.stringify(frame)}\n`)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('claude stdin control frames', () => {
  it('writes the initial prompt as the first stream-json user frame', () => {
    const frame = buildUserFrame('do the thing')
    const { child } = harness({ initialPrompt: frame })

    expect(child.lines).toEqual([`${JSON.stringify(frame)}\n`])
  })

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

  it('respondApproval answers can_use_tool requests with real control_response frames', () => {
    const { child, adapter } = harness()

    // A can_use_tool request arrives on stdout; its tool name is remembered.
    startPump(adapter)
    emitStdout(child, {
      type: 'control_request',
      request_id: 'req_1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
    })
    // Give the pump a tick to consume the line before answering.
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      adapter.respondApproval('req_1', 'allow')
      expect(child.lines.at(-1)).toEqual(`${JSON.stringify(buildApprovalResponseFrame('req_1', 'allow'))}\n`)

      // always-allow upgrades to a session-scoped allow rule for the seen tool.
      emitStdout(child, {
        type: 'control_request',
        request_id: 'req_2',
        request: { subtype: 'can_use_tool', tool_name: 'Edit', input: {} },
      })
      return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
        adapter.respondApproval('req_2', 'always-allow')
        const frame = JSON.parse(child.lines.at(-1) ?? '{}') as {
          response: { response: { updatedPermissions?: { rules: { toolName: string }[] }[] } }
        }
        expect(frame.response.response.updatedPermissions?.[0]?.rules[0]?.toolName).toBe('Edit')
      })
    })
  })

  it('respondApproval still answers (plain allow) when no matching request was seen', () => {
    const { child, adapter } = harness()

    adapter.respondApproval('ghost', 'allow')
    expect(child.lines).toEqual([`${JSON.stringify(buildApprovalResponseFrame('ghost', 'allow'))}\n`])
  })

  it('answers unsupported control subtypes with an error control_response so the CLI cannot stall', () => {
    const { child, adapter } = harness()

    startPump(adapter)
    emitStdout(child, {
      type: 'control_request',
      request_id: 'req_9',
      request: { subtype: 'mystery' },
    })

    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      expect(child.lines.at(-1)).toEqual(
        `${JSON.stringify(buildUnsupportedControlResponse('req_9', 'mystery'))}\n`,
      )
    })
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
