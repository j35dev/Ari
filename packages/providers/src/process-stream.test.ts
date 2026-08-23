import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { streamProcessEvents } from './process-stream'

interface FakeChild {
  stdout: PassThrough
  stderr: PassThrough
  close(code: number | null): void
}

function fakeChild(): FakeChild & { on: (event: string, cb: (code: number | null) => void) => void } {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let closeCb: ((code: number | null) => void) | null = null
  return {
    stdout,
    stderr,
    on(event: string, cb: (code: number | null) => void) {
      if (event === 'close') closeCb = cb
    },
    close(code: number | null) {
      closeCb?.(code)
    },
  }
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of iterable) out.push(event)
  return out
}

describe('streamProcessEvents', () => {
  it('maps stdout lines and guarantees one terminal done', async () => {
    const child = fakeChild()
    const events = collect(streamProcessEvents(child, (line) => [{ type: 'text-delta', text: line }]))
    child.stdout.write('hello\nworld\n')
    child.close(0)
    const out = await events
    expect(out).toEqual([
      { type: 'text-delta', text: 'hello' },
      { type: 'text-delta', text: 'world' },
      { type: 'done' },
    ])
  })

  it('appends the last stderr lines to the non-zero-exit error message', async () => {
    const child = fakeChild()
    const events = collect(streamProcessEvents(child, () => [], { label: 'claude' }))
    // More than 8 chunks: only the tail should survive into the error.
    for (let i = 1; i <= 12; i++) child.stderr.write(`noise line ${i}\n`)
    child.stdout.end()
    child.close(2)
    const out = await events
    const error = out.find((e) => e.type === 'error')
    expect(error).toBeDefined()
    if (error?.type === 'error') {
      expect(error.message).toContain('claude exited with code 2')
      expect(error.message).toContain('noise line 12')
      expect(error.message).not.toContain('noise line 1\n')
      expect(out.at(-1)).toEqual({ type: 'done' })
    }
  })

  it('reports a clean zero-exit without any error event even when stderr fired', async () => {
    const child = fakeChild()
    const events = collect(streamProcessEvents(child, () => []))
    child.stderr.write('harmless warning\n')
    child.close(0)
    const out = await events
    expect(out.some((e) => e.type === 'error')).toBe(false)
    expect(out).toEqual([{ type: 'done' }])
  })

  it('fails the stream with the stderr tail when the handshake window lapses', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      const events = collect(
        streamProcessEvents(child, () => [], { label: 'codex', handshakeTimeoutMs: 5_000 }),
      )
      child.stderr.write('waiting for auth\n')
      const promise = events
      await vi.advanceTimersByTimeAsync(5_001)
      const out = await promise
      const error = out.find((e) => e.type === 'error')
      expect(error).toBeDefined()
      if (error?.type === 'error') {
        expect(error.message).toContain('codex produced no output within 5s')
        expect(error.message).toContain('waiting for auth')
      }
      expect(out.at(-1)).toEqual({ type: 'done' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('disarms the handshake once real output arrives', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      const iterator = streamProcessEvents(
        child,
        (line) => [{ type: 'text-delta', text: line }],
        { handshakeTimeoutMs: 5_000 },
      )[Symbol.asyncIterator]()
      child.stdout.write('alive\n')
      const first = await Promise.race([
        iterator.next(),
        new Promise<null>((r) => setTimeout(() => r(null), 50)),
      ])
      expect(first?.value).toEqual({ type: 'text-delta', text: 'alive' })
      // Well past the original window: no error may appear.
      await vi.advanceTimersByTimeAsync(10_000)
      child.close(0)
      const drained: AgentEvent[] = []
      for (;;) {
        const next = await iterator.next()
        if (next.done) break
        drained.push(next.value)
      }
      expect(drained.some((e) => e.type === 'error')).toBe(false)
      expect(drained.at(-1)).toEqual({ type: 'done' })
    } finally {
      vi.useRealTimers()
    }
  })
})
