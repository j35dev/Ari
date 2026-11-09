// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
const runtime = vi.hoisted(() => ({ read: vi.fn(), spawn: vi.fn() }))
vi.mock('node:fs', () => ({ readFileSync: runtime.read }))
vi.mock('node:child_process', () => ({ spawn: runtime.spawn }))
vi.mock('electron', () => ({
  app: { getPath: () => '/test-profile', getAppMetrics: () => [{ pid: 42 }] },
}))
import { AudioDuckingController } from './audio-ducking'
import type { ChildProcess } from 'node:child_process'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function child() {
  return Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn(),
    unref: vi.fn(),
    channel: { unref: vi.fn() },
  })
}

it('shares one helper across overlapping owners and restores only after the last release', () => {
  vi.useFakeTimers()
  const worker = child()
  const launch = vi.fn(() => worker as unknown as ChildProcess)
  const controller = new AudioDuckingController(launch, () => [1, 2])
  controller.setActive('first', true)
  controller.setActive('first', true)
  controller.setActive('second', true)
  controller.setActive('first', false)
  expect(launch).toHaveBeenCalledOnce()
  expect(worker.send).toHaveBeenLastCalledWith(
    { active: true, excluded: [1, 2] },
    expect.any(Function),
  )
  controller.setActive('second', false)
  expect(worker.send).toHaveBeenLastCalledWith(
    { active: false, excluded: [1, 2] },
    expect.any(Function),
  )
  expect(vi.getTimerCount()).toBe(0)
})

it('reconciles a late helper readiness against cancellation and recovers a failed helper', async () => {
  vi.useFakeTimers()
  const first = child()
  const second = child()
  const launch = vi.fn().mockReturnValueOnce(first).mockReturnValue(second)
  const controller = new AudioDuckingController(launch, () => [1])
  controller.setActive('capture', true)
  controller.setActive('capture', false)
  first.emit('message', { ready: true })
  expect(first.send).toHaveBeenLastCalledWith(
    { active: false, excluded: [1] },
    expect.any(Function),
  )
  first.emit('exit', 1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(launch).toHaveBeenCalledTimes(2)
  expect(second.send).toHaveBeenLastCalledWith(
    { active: false, excluded: [1] },
    expect.any(Function),
  )
})

it('starts pending restoration at app startup without requiring another recording', () => {
  const worker = child()
  const launch = vi.fn(() => worker as unknown as ChildProcess)
  new AudioDuckingController(launch, () => [1], vi.fn(), true)
  expect(launch).toHaveBeenCalledOnce()
  worker.emit('message', { ready: true })
  expect(worker.send).toHaveBeenLastCalledWith(
    { active: false, excluded: [1] },
    expect.any(Function),
  )
})

it('recovers the persisted profile journal through the production factory', async () => {
  vi.resetModules()
  runtime.read.mockReturnValue(
    JSON.stringify([{ id: 'playback', original: [0.8], applied: [0.2] }]),
  )
  const worker = child()
  runtime.spawn.mockReturnValue(worker)
  const { getAudioDucking } = await import('./audio-ducking')
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  getAudioDucking()
  expect(runtime.spawn).toHaveBeenCalledWith(
    process.execPath,
    expect.arrayContaining([expect.stringMatching(/audio-ducking-worker\.js$/)]),
    expect.objectContaining({
      windowsHide: true,
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    }),
  )
  worker.emit('message', { ready: true })
  expect(worker.send).toHaveBeenLastCalledWith(
    { active: false, excluded: [process.pid, 42] },
    expect.any(Function),
  )
})

it('caps crashes after readiness within a capture and retries for a later capture', async () => {
  vi.useFakeTimers()
  const workers: ReturnType<typeof child>[] = []
  const launch = vi.fn(() => {
    const worker = child()
    workers.push(worker)
    return worker as unknown as ChildProcess
  })
  const controller = new AudioDuckingController(launch, () => [1])
  controller.setActive('capture', true)
  for (let i = 0; i < 4; i++) {
    workers[i]!.emit('message', { ready: true })
    workers[i]!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(6000)
  }
  controller.setActive('capture', true)
  expect(launch).toHaveBeenCalledTimes(4)
  controller.setActive('capture', false)
  controller.setActive('next', true)
  expect(launch).toHaveBeenCalledTimes(5)
})

it('retries a failed spawn that closes without exit and ignores duplicate exit/close events', async () => {
  vi.useFakeTimers()
  const first = child()
  const second = child()
  const launch = vi.fn().mockReturnValueOnce(first).mockReturnValue(second)
  const warn = vi.fn()
  const controller = new AudioDuckingController(launch, () => [1], warn)
  controller.setActive('capture', true)
  first.emit('error', new Error('Helper executable unavailable'))
  first.emit('close', -1)
  first.emit('exit', -1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(launch).toHaveBeenCalledTimes(2)
  expect(warn).toHaveBeenCalledOnce()
  controller.setActive('capture', false)
  expect(second.send).toHaveBeenLastCalledWith(
    { active: false, excluded: [1] },
    expect.any(Function),
  )
})
