import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { teardownChild } from './teardown'

/** Minimal child double: controllable exit timing, no real process. */
class FakeChild extends EventEmitter {
  stdin = { end: vi.fn(), writableEnded: false }
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  pid: number | undefined = 4242
  /** When true, kill() is a no-op — models a process ignoring the signal. */
  ignoresSignals = false

  kill(signal?: string): boolean {
    if (this.exitCode !== null || this.ignoresSignals) return false
    this.killed = true
    // Windows cannot intercept signals; model the common case where the
    // default disposition terminates the process.
    this.signalCode = (signal ?? 'SIGTERM') as NodeJS.Signals
    queueMicrotask(() => {
      this.emit('close')
    })
    return true
  }

  /** Simulates the process exiting on its own after `ms`. */
  exitsAfter(ms: number): void {
    setTimeout(() => {
      this.exitCode = 0
      this.emit('close')
    }, ms)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('teardownChild', () => {
  it('is a no-op on an already-exited child', async () => {
    const child = new FakeChild()
    child.exitCode = 0
    await expect(teardownChild(child)).resolves.toBeUndefined()
    expect((child.stdin.end as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('stops at rung 1 when the process exits on stdin EOF', async () => {
    const child = new FakeChild()
    child.exitsAfter(5)
    const killTree = vi.fn().mockResolvedValue(undefined)
    await teardownChild(child, { eofGraceMs: 500, killTree })
    expect(child.stdin.end).toHaveBeenCalledOnce()
    expect(child.killed).toBe(false)
    expect(killTree).not.toHaveBeenCalled()
  })

  it('escalates to SIGTERM when EOF is ignored, and stops there on exit', async () => {
    const child = new FakeChild()
    const killTree = vi.fn().mockResolvedValue(undefined)
    // Exits only once the SIGTERM arrives (kill() emits close in the double).
    const done = teardownChild(child, {
      eofGraceMs: 10,
      termGraceMs: 100,
      killTree,
    })
    await done
    expect(child.killed).toBe(true)
    expect(child.signalCode).toBe('SIGTERM')
    expect(killTree).not.toHaveBeenCalled()
  })

  it('reaches the tree-kill rung when even SIGTERM fails', async () => {
    const child = new FakeChild()
    // A process stuck in uninterruptible work ignores every signal.
    child.ignoresSignals = true
    // Never exits from signals; the tree kill must still resolve the ladder.
    const killTree = vi.fn(async () => {
      child.exitCode = 1
      child.emit('close')
    })
    await teardownChild(child, {
      eofGraceMs: 10,
      termGraceMs: 10,
      killTree,
    })
    expect(killTree).toHaveBeenCalledWith(4242)
  })

  it('survives a child whose stdin already ended', async () => {
    const child = new FakeChild()
    child.stdin.writableEnded = true
    child.exitsAfter(5)
    await expect(
      teardownChild(child, { eofGraceMs: 500 }),
    ).resolves.toBeUndefined()
  })

  it('takes down a real node child that exits on stdin EOF', async () => {
    // Real integration: `node -e` with a stdin listener ends when EOF lands.
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    await expect(teardownChild(child)).resolves.toBeUndefined()
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  }, 15000)
})
