import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstallEvent } from './install'
import { runInstall } from './install'

function collect(): { events: InstallEvent[]; onEvent: (event: InstallEvent) => void } {
  const events: InstallEvent[] = []
  return { events, onEvent: (event) => events.push(event) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runInstall', () => {
  it('rejects an empty argv without spawning', async () => {
    const { events, onEvent } = collect()
    const handle = runInstall([], onEvent)
    await handle.done
    expect(events).toEqual([{ type: 'failed', reason: 'empty argv', durationMs: 0 }])
  })

  it('streams stdout lines as progress and reports a clean exit', async () => {
    const { events, onEvent } = collect()
    // node -e printing two lines then exiting 0 — cross-platform.
    const child = spawn(process.execPath, ['-e', 'console.log("line-1"); console.log("line-2")'])
    void child
    const handle = runInstall([process.execPath, '-e', 'console.log("line-1"); console.log("line-2")'], onEvent)
    await handle.done

    const progress = events.filter((event) => event.type === 'progress')
    expect(progress.map((event) => (event.type === 'progress' ? event.line.text : ''))).toEqual(['line-1', 'line-2'])
    const exit = events.at(-1)
    expect(exit).toMatchObject({ type: 'exit', code: 0, timedOut: false, truncated: false })
  }, 15000)

  it('captures stderr lines too', async () => {
    const { events, onEvent } = collect()
    const handle = runInstall(
      [process.execPath, '-e', 'console.error("to-stderr")'],
      onEvent,
    )
    await handle.done
    expect(events.some((event) => event.type === 'progress' && event.line.stream === 'stderr' && event.line.text === 'to-stderr')).toBe(true)
  }, 15000)

  it('reports a non-zero exit without inventing a failure reason', async () => {
    const { events, onEvent } = collect()
    const handle = runInstall([process.execPath, '-e', 'process.exit(3)'], onEvent)
    await handle.done
    expect(events.at(-1)).toMatchObject({ type: 'exit', code: 3 })
  }, 15000)

  it('times out a hung process and tears it down', async () => {
    vi.useFakeTimers()
    const { events, onEvent } = collect()
    // Real child that never exits; the timeout ladder must reap it.
    const handle = runInstall(
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      onEvent,
      { timeoutMs: 50 },
    )
    await vi.advanceTimersByTimeAsync(5_000)
    await handle.done
    const exit = events.at(-1)
    expect(exit).toMatchObject({ type: 'exit', timedOut: true })
    expect((exit as Extract<InstallEvent, { type: 'exit' }>).code !== 0 || (exit as Extract<InstallEvent, { type: 'exit' }>).signal !== null).toBe(true)
  }, 15000)

  it('cancel() ends a running operation early', async () => {
    const { events, onEvent } = collect()
    const handle = runInstall([process.execPath, '-e', 'setInterval(() => {}, 1000)'], onEvent)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    await handle.cancel()
    await handle.done
    const exit = events.at(-1)
    expect(exit?.type === 'exit' || exit?.type === 'failed').toBe(true)
  }, 15000)

  it('marks output as truncated when the tail cap is exceeded', async () => {
    const { events, onEvent } = collect()
    const handle = runInstall(
      [
        process.execPath,
        '-e',
        'for (let i = 0; i < 2000; i++) console.log("x".repeat(40))',
      ],
      onEvent,
      { outputTailBytes: 512 },
    )
    await handle.done
    expect(events.at(-1)).toMatchObject({ type: 'exit', truncated: true, code: 0 })
  }, 20000)
})