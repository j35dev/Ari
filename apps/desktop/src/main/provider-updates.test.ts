// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { DriverKind } from '@ari/contracts/common'
import type { ProvidersUpdateFrame } from '@ari/contracts/rpc'
import type { InstallEvent, runInstall } from '@ari/providers/install'
import { planFor } from '@ari/providers/package-manager'
import type { Detection } from '@ari/providers/types'
import { ProviderProbes, ProviderUpdates } from './provider-updates'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function detection(kind: DriverKind, version = '1.0.0'): Detection {
  return {
    kind,
    installed: true,
    binaryPath: `C:/Users/u/AppData/Roaming/npm/${kind}.cmd`,
    version,
    authStatus: 'unknown',
    latestVersion: '2.0.0',
  }
}

function harness() {
  const frames: ProvidersUpdateFrame[] = []
  const processes: {
    finish: (code?: number, output?: string, timedOut?: boolean) => void
    fail: (reason: string) => void
    emit: (event: InstallEvent) => void
  }[] = []
  const prepare = vi.fn(async (kind: DriverKind) => ({
    before: detection(kind),
    plan: planFor(kind, detection(kind).binaryPath, 'win32'),
    env: {},
  }))
  const busy = vi.fn(async (_kind: DriverKind) => false)
  const release = vi.fn(async (_kind: DriverKind) => undefined)
  const detect = vi.fn(async (kind: DriverKind) => detection(kind, '2.0.0'))
  const updated = vi.fn()
  const wait = vi.fn(async (_ms: number): Promise<void> => undefined)
  const run = vi.fn<typeof runInstall>((_argv, emit) => {
    const gate = deferred()
    const finish = (code = 0, output = '', timedOut = false) => {
      if (output) emit({ type: 'progress', line: { stream: 'stderr', text: output } })
      emit({ type: 'exit', code, signal: null, durationMs: 10, truncated: false, timedOut })
      gate.resolve()
    }
    processes.push({
      finish,
      emit,
      fail: (reason) => {
        emit({ type: 'failed', reason, durationMs: 0 })
        gate.resolve()
      },
    })
    return { done: gate.promise, cancel: async () => finish(1) }
  })
  const updates = new ProviderUpdates({
    prepare,
    busy,
    release,
    detect,
    updated,
    run,
    wait,
    publish: (frame) => frames.push(frame),
  })
  const settled = () => frames.filter((frame) => frame.type === 'install.settled')
  return { updates, frames, processes, prepare, busy, release, detect, updated, wait, run, settled }
}

describe('ProviderUpdates', () => {
  it('drains background checks started during preparation before spawning', async () => {
    const h = harness()
    const gate = deferred()
    const prepare = h.prepare.getMockImplementation()!
    h.prepare.mockImplementationOnce(async (kind) => {
      h.busy.mockResolvedValueOnce(true).mockResolvedValue(false)
      return prepare(kind)
    })
    h.wait.mockImplementationOnce(() => gate.promise)
    h.updates.start('codex', 'upgrade')
    await expect.poll(() => h.wait.mock.calls.length).toBe(1)
    expect(h.updates.installing('codex')).toBe(true)
    expect(h.updates.preservedDetection('codex')?.version).toBe('1.0.0')
    expect(h.run).not.toHaveBeenCalled()
    expect(h.release).not.toHaveBeenCalled()
    gate.resolve()
    await expect.poll(() => h.run.mock.calls.length).toBe(1)
    h.processes[0]!.finish()
    await expect.poll(() => h.settled().length).toBe(1)
  })
  it('reserves synchronously and runs update-all serially through verification', async () => {
    const h = harness()
    expect(h.updates.start('codex', 'upgrade')).toEqual({ started: true })
    expect(h.updates.start('codex', 'upgrade').started).toBe(false)
    h.updates.start('pi', 'upgrade')
    await expect.poll(() => h.processes.length).toBe(1)
    expect(h.updates.unavailable('codex')).toMatch(/updating.*shortly/)
    expect(h.updates.unavailable('pi')).toBeNull()
    expect(h.release).toHaveBeenCalledBefore(h.run)
    h.processes[0]!.finish()
    await expect.poll(() => h.processes.length).toBe(2)
    expect(h.settled()[0]).toMatchObject({ kind: 'codex', ok: true, version: '2.0.0' })
    expect(h.detect).toHaveBeenCalledBefore(h.updated)
    h.processes[1]!.finish()
    await expect.poll(() => h.settled().length).toBe(2)
    expect(h.updates.unavailable('codex')).toBeNull()
  })

  it('waits for all current turns before releasing idle processes or spawning', async () => {
    const h = harness()
    const idle = deferred()
    h.busy.mockResolvedValueOnce(true).mockResolvedValue(false)
    h.wait.mockImplementationOnce(() => idle.promise)
    h.updates.start('claude', 'upgrade')
    await expect.poll(() => h.wait.mock.calls.length).toBe(1)
    expect(h.frames).toContainEqual({
      type: 'install.phase',
      kind: 'claude',
      phase: 'waiting',
      message: 'Will update when the current turns finish.',
    })
    expect(h.run).not.toHaveBeenCalled()
    expect(h.release).not.toHaveBeenCalled()
    idle.resolve()
    await expect.poll(() => h.run.mock.calls.length).toBe(1)
    h.processes[0]!.finish()
    await expect.poll(() => h.settled().length).toBe(1)
  })

  it('re-detects a newly activated version before declaring success', async () => {
    const h = harness()
    h.detect
      .mockResolvedValueOnce(detection('codex'))
      .mockResolvedValueOnce(detection('codex', '2.0.0'))
    h.updates.start('codex', 'upgrade')
    await expect.poll(() => h.processes.length).toBe(1)
    h.processes[0]!.finish()
    await expect.poll(() => h.settled().length).toBe(1)
    expect(h.detect).toHaveBeenCalledTimes(2)
    expect(h.frames).toContainEqual({
      type: 'install.phase',
      kind: 'codex',
      phase: 'verifying',
      message: 'Checking the installed CLI version…',
    })
    expect(h.settled()[0]?.ok).toBe(true)
  })

  it('publishes useful errors and raw output, then accepts Retry', async () => {
    const h = harness()
    h.updates.start('codex', 'upgrade')
    await expect.poll(() => h.processes.length).toBe(1)
    h.processes[0]!.finish(1, 'npm ERR! EBUSY rename codex.exe')
    await expect.poll(() => h.settled().length).toBe(1)
    expect(h.settled()[0]).toMatchObject({
      ok: false,
      reason: 'The CLI is still in use. Let its sessions finish, then retry.',
      details: expect.stringContaining('EBUSY'),
    })
    expect(h.detect).toHaveBeenCalledOnce()
    expect(h.updated).not.toHaveBeenCalled()
    expect(h.updates.start('codex', 'upgrade')).toEqual({ started: true })
    await expect.poll(() => h.processes.length).toBe(2)
    h.processes[1]!.finish()
    await expect.poll(() => h.settled().length).toBe(2)
    expect(h.settled()[1]?.ok).toBe(true)
  })

  it.each([
    ['ENOENT npm', /package manager was not found/],
    ['npm ERR! ENOTFOUND registry.npmjs.org', /connection or proxy/],
    ['EPERM rename codex.exe', /locked the CLI/],
  ])('maps a spawn/output failure %s and continues the queue', async (error, reason) => {
    const h = harness()
    h.updates.start('codex', 'upgrade')
    h.updates.start('pi', 'upgrade')
    await expect.poll(() => h.processes.length).toBe(1)
    h.processes[0]!.fail(error)
    await expect.poll(() => h.processes.length).toBe(2)
    expect(h.settled()[0]).toMatchObject({ ok: false, reason: expect.stringMatching(reason) })
    h.processes[1]!.finish()
    await expect.poll(() => h.settled().length).toBe(2)
  })

  it('settles verification exceptions instead of leaving the spinner running', async () => {
    const h = harness()
    h.detect.mockRejectedValueOnce(new Error('probe failed'))
    h.updates.start('codex', 'upgrade')
    await expect.poll(() => h.processes.length).toBe(1)
    h.processes[0]!.finish()
    await expect.poll(() => h.settled().length).toBe(1)
    expect(h.settled()[0]).toMatchObject({
      ok: false,
      reason: expect.stringContaining('verified'),
      details: expect.stringContaining('probe failed'),
    })
  })

  it('cancels a queued provider without ever spawning it', async () => {
    const h = harness()
    h.updates.start('codex', 'upgrade')
    h.updates.start('pi', 'upgrade')
    expect(await h.updates.cancel('pi')).toEqual({ cancelled: true })
    await expect.poll(() => h.processes.length).toBe(1)
    h.processes[0]!.finish()
    await expect.poll(() => h.settled().length).toBe(2)
    expect(h.run).toHaveBeenCalledOnce()
    expect(h.settled()[0]).toMatchObject({
      kind: 'pi',
      ok: false,
      reason: expect.stringContaining('cancelled'),
    })
  })

  it('replays active phases and settled errors to late subscribers', async () => {
    const h = harness()
    h.updates.start('codex', 'upgrade')
    await expect.poll(() => h.processes.length).toBe(1)
    h.processes[0]!.emit({
      type: 'progress',
      line: { stream: 'stdout', text: 'Downloading update…' },
    })
    expect(h.updates.snapshot()).toContainEqual({
      type: 'install.phase',
      kind: 'codex',
      phase: 'downloading',
      message: 'Downloading the update…',
    })
    expect(h.updates.installing('codex')).toBe(true)
    expect(h.updates.preservedDetection('codex')?.version).toBe('1.0.0')
    h.processes[0]!.finish(1, 'network failed')
    await expect.poll(() => h.settled().length).toBe(1)
    expect(h.updates.snapshot()).toEqual([h.settled()[0]])
  })
})

describe('ProviderProbes', () => {
  it('tracks every concurrent reader until it releases its process', async () => {
    const probes = new ProviderProbes()
    const first = deferred()
    const second = deferred()
    const one = probes.run('codex', () => first.promise)
    const two = probes.run('codex', () => second.promise)
    expect(probes.busy('codex')).toBe(true)
    expect(probes.busy('claude')).toBe(false)
    first.resolve()
    await one
    expect(probes.busy('codex')).toBe(true)
    second.resolve()
    await two
    expect(probes.busy('codex')).toBe(false)
  })

  it('releases the reader count when a probe fails', async () => {
    const probes = new ProviderProbes()
    await expect(
      probes.run('codex', async () => {
        throw new Error('offline')
      }),
    ).rejects.toThrow('offline')
    expect(probes.busy('codex')).toBe(false)
  })
})
