import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnCli } from './spawn-cli'
import { interruptChild, teardownChild, trackShellWrapper } from './teardown'

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
    expect(child.stdin.end as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
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
      platform: 'linux',
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
      platform: 'linux',
    })
    expect(killTree).toHaveBeenCalledWith(4242)
  })

  it('kills the whole tree on Windows before touching the direct child', async () => {
    // SIGTERM on Windows ends only a cmd.exe shim and orphans the real CLI.
    const child = new FakeChild()
    const killTree = vi.fn(async () => {
      child.exitCode = 1
      child.emit('close')
    })
    await teardownChild(child, { eofGraceMs: 10, termGraceMs: 100, killTree, platform: 'win32' })
    expect(killTree).toHaveBeenCalledWith(4242)
    expect(child.killed).toBe(false)
  })

  it('still reaches what a gone Windows shell wrapper started while it held the pipes', async () => {
    const child = new FakeChild()
    trackShellWrapper(child)
    // The wrapper exited, but its CLI still holds stdio open: no close yet.
    child.exitCode = 1
    child.emit('exit')
    const killOrphans = vi.fn(async () => {
      child.emit('close')
    })
    await teardownChild(child, { platform: 'win32', killOrphans })
    expect(killOrphans).toHaveBeenCalledWith(4242, expect.any(Number), expect.any(Number))
    const [, spawnedAt, exitedAt] = killOrphans.mock.calls[0] as unknown as [number, number, number]
    expect(exitedAt).toBeGreaterThanOrEqual(spawnedAt)

    // Once the pipes closed, nothing is left to reach.
    const closed = new FakeChild()
    trackShellWrapper(closed)
    closed.exitCode = 0
    closed.emit('exit')
    closed.emit('close')
    await teardownChild(closed, { platform: 'win32', killOrphans })
    expect(killOrphans).toHaveBeenCalledOnce()
  })

  it.runIf(process.platform === 'win32')(
    'stops the real CLI behind an npm .cmd shim on interrupt and after the shim is gone',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ari-teardown-'))
      try {
        // An npm-style shim: cmd.exe runs node, which reports its pid and idles.
        const script = join(dir, 'agent.js')
        await writeFile(script, 'console.log(process.pid); setInterval(() => {}, 1000)\n')
        const shim = join(dir, 'agent.cmd')
        await writeFile(shim, `@"${process.execPath}" "${script}" %*\r\n`)
        const alive = (pid: number): boolean => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        }
        const start = async () => {
          const child = spawnCli(shim, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
          const pid = await new Promise<number>((resolvePid) =>
            child.stdout.once('data', (chunk: Buffer) => resolvePid(Number(String(chunk).trim()))),
          )
          expect(alive(pid)).toBe(true)
          return { child, pid }
        }

        // Stop: the driver interrupt path.
        const first = await start()
        const closed = new Promise((resolveClose) => first.child.once('close', resolveClose))
        interruptChild(first.child)
        await closed
        expect(alive(first.pid)).toBe(false)

        // A bare kill() ends only cmd.exe; dispose must still reach node.
        const second = await start()
        second.child.kill()
        await new Promise((resolveExit) => second.child.once('exit', resolveExit))
        expect(alive(second.pid)).toBe(true)
        await teardownChild(second.child)
        await vi.waitFor(() => expect(alive(second.pid)).toBe(false), { timeout: 10_000 })
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    },
    60_000,
  )

  it('survives a child whose stdin already ended', async () => {
    const child = new FakeChild()
    child.stdin.writableEnded = true
    child.exitsAfter(5)
    await expect(teardownChild(child, { eofGraceMs: 500 })).resolves.toBeUndefined()
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
