import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstallEvent } from './install'
import { programOnPath, resolveInstallProgram, ringTail, runInstall } from './install'

function collect(): { events: InstallEvent[]; onEvent: (event: InstallEvent) => void } {
  const events: InstallEvent[] = []
  return { events, onEvent: (event) => events.push(event) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runInstall', () => {
  it.skipIf(process.platform !== 'win32')(
    'resolves the enriched PATH rather than a stale mixed-case Path',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'ari-install-path-'))
      try {
        await writeFile(join(directory, 'updater.cmd'), '')
        expect(
          resolveInstallProgram('updater', { Path: 'C:/missing/old-path', PATH: directory }),
        ).toBe(join(directory, 'updater.cmd'))
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
  it('emits exactly one terminal event when the updater cannot spawn', async () => {
    const { events, onEvent } = collect()
    await runInstall(['ari-provider-updater-that-does-not-exist.exe'], onEvent).done
    expect(events.filter((event) => event.type === 'failed' || event.type === 'exit')).toHaveLength(
      1,
    )
    const last = events.at(-1)
    expect(last?.type).toBe('failed')
    if (last?.type === 'failed') expect(last.reason).toContain('ENOENT')
  })

  it('reports a synchronous spawn error as a terminal failure', async () => {
    const { events, onEvent } = collect()
    await runInstall([process.execPath, '\u0000'], onEvent).done
    expect(events).toHaveLength(1)
    const last = events[0]
    expect(last?.type).toBe('failed')
    if (last?.type === 'failed') expect(last.reason).toContain('null bytes')
  })

  it('keeps the last diagnostic even without a newline', async () => {
    const { events, onEvent } = collect()
    await runInstall(
      [process.execPath, '-e', 'process.stderr.write("EBUSY locked executable"); process.exit(1)'],
      onEvent,
    ).done
    expect(events).toContainEqual({
      type: 'progress',
      line: { stream: 'stderr', text: 'EBUSY locked executable' },
    })
  })

  it.skipIf(process.platform !== 'win32')(
    'runs npm install --help through the actual Windows shim without mangling arguments',
    async () => {
      const { events, onEvent } = collect()
      await runInstall(['npm', 'install', '--help'], onEvent, { timeoutMs: 30_000 }).done
      expect(events.at(-1)).toMatchObject({ type: 'exit', code: 0 })
      const output = events
        .filter((event) => event.type === 'progress')
        .map((event) => event.line.text)
        .join('\n')
      expect(output).toContain('npm install')
      expect(output).not.toContain('Unknown command')
    },
    35_000,
  )
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
    const handle = runInstall(
      [process.execPath, '-e', 'console.log("line-1"); console.log("line-2")'],
      onEvent,
    )
    await handle.done

    const progress = events.filter((event) => event.type === 'progress')
    expect(progress.map((event) => (event.type === 'progress' ? event.line.text : ''))).toEqual([
      'line-1',
      'line-2',
    ])
    const exit = events.at(-1)
    expect(exit).toMatchObject({ type: 'exit', code: 0, timedOut: false, truncated: false })
  }, 15000)

  it('captures stderr lines too', async () => {
    const { events, onEvent } = collect()
    const handle = runInstall([process.execPath, '-e', 'console.error("to-stderr")'], onEvent)
    await handle.done
    expect(
      events.some(
        (event) =>
          event.type === 'progress' &&
          event.line.stream === 'stderr' &&
          event.line.text === 'to-stderr',
      ),
    ).toBe(true)
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
    const handle = runInstall([process.execPath, '-e', 'setInterval(() => {}, 1000)'], onEvent, {
      timeoutMs: 50,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await handle.done
    const exit = events.at(-1)
    expect(exit).toMatchObject({ type: 'exit', timedOut: true })
    expect(
      (exit as Extract<InstallEvent, { type: 'exit' }>).code !== 0 ||
        (exit as Extract<InstallEvent, { type: 'exit' }>).signal !== null,
    ).toBe(true)
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
      [process.execPath, '-e', 'for (let i = 0; i < 2000; i++) console.log("x".repeat(40))'],
      onEvent,
      { outputTailBytes: 512 },
    )
    await handle.done
    expect(events.at(-1)).toMatchObject({ type: 'exit', truncated: true, code: 0 })
  }, 20000)

  it('tracks overflow across chunks that are each under the cap', () => {
    const ring = ringTail(16)
    for (let i = 0; i < 10; i++) ring.push(`line-${i}\n`, () => {}, 'stdout')
    expect(ring.overflowed()).toBe(true)
  })

  it('does not report overflow while the stream stays under the cap', () => {
    const ring = ringTail(64)
    for (const line of ['one\n', 'two\n']) ring.push(line, () => {}, 'stdout')
    expect(ring.overflowed()).toBe(false)
  })
})

describe('programOnPath', () => {
  it('finds a program on PATH and reports a missing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-path-'))
    try {
      await writeFile(join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm'), '')
      expect(programOnPath('npm', dir)).toBe(true)
      expect(programOnPath('bun', dir)).toBe(false)
      expect(programOnPath('npm', '')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
