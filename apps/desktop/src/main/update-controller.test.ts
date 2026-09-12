import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateFrame } from '@ari/contracts/rpc'
import {
  createUpdateController,
  type UpdateController,
  type UpdateHandlers,
  type UpdatePort,
} from './update-controller'

interface Harness {
  controller: UpdateController
  handlers: UpdateHandlers
  frames: AppUpdateFrame[]
  /** The fake port, so tests can assert what the controller drove. */
  fake: {
    checkForUpdates: ReturnType<typeof vi.fn>
    downloadUpdate: ReturnType<typeof vi.fn>
    quitAndInstall: ReturnType<typeof vi.fn>
    autoDownload: boolean
    installOnQuit: boolean
  }
}

function harness(enabled = true, currentVersion = '0.3.0'): Harness {
  const checkForUpdates = vi.fn<() => Promise<unknown>>().mockResolvedValue(null)
  const downloadUpdate = vi.fn<() => Promise<unknown>>().mockResolvedValue([])
  const quitAndInstall = vi.fn<() => void>()
  const frames: AppUpdateFrame[] = []
  const fake: Harness['fake'] = {
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    autoDownload: true,
    installOnQuit: false,
  }
  const port: UpdatePort = {
    currentVersion: () => currentVersion,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    setAutoDownload: (value) => {
      fake.autoDownload = value
    },
    setInstallOnQuit: (value) => {
      fake.installOnQuit = value
    },
  }
  let handlers!: UpdateHandlers
  const controller = createUpdateController({
    createPort: (wired) => {
      handlers = wired
      return port
    },
    publish: (frame) => frames.push(frame),
    enabled,
  })
  return { controller, handlers, frames, fake }
}

/** Lets a rejected port promise reach its `.catch` before the assertion. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createUpdateController', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('never downloads on its own, and keeps install-on-quit as the safety net', () => {
    const h = harness()
    expect(h.fake.autoDownload).toBe(false)
    expect(h.fake.installOnQuit).toBe(true)
  })

  it('announces an available release with the running version', () => {
    const h = harness()
    h.controller.check(true)
    h.handlers.available('0.4.0')
    expect(h.frames).toEqual([
      { type: 'checking', manual: true },
      { type: 'available', version: '0.4.0', currentVersion: '0.3.0' },
    ])
    // Announcing must not touch the network a second time.
    expect(h.fake.downloadUpdate).not.toHaveBeenCalled()
  })

  it('reports nothing to do as `none` rather than an error', () => {
    const h = harness()
    h.controller.check(false)
    h.handlers.notAvailable()
    const last = h.frames.at(-1)
    expect(last?.type).toBe('none')
    expect(last).toHaveProperty('at')
  })

  it('refuses to download before a check has found anything', () => {
    const h = harness()
    expect(h.controller.download()).toEqual({
      started: false,
      reason: 'No update is available to download.',
    })
    expect(h.fake.downloadUpdate).not.toHaveBeenCalled()
  })

  it('downloads on request and walks progress through to staged', () => {
    const h = harness()
    h.controller.check(true)
    h.handlers.available('0.4.0')
    expect(h.controller.download()).toEqual({ started: true, reason: null })
    h.handlers.progress(41.6)
    h.handlers.downloaded('0.4.0')
    expect(h.frames.slice(2)).toEqual([
      { type: 'download.started', version: '0.4.0' },
      { type: 'download.progress', percent: 42 },
      { type: 'downloaded', version: '0.4.0' },
    ])
    expect(h.controller.install()).toEqual({ started: true, reason: null })
    expect(h.fake.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('refuses a second download while one is in flight', () => {
    const h = harness()
    h.controller.check(true)
    h.handlers.available('0.4.0')
    h.controller.download()
    expect(h.controller.download()).toEqual({
      started: false,
      reason: 'An update is already downloading.',
    })
  })

  it('re-offers the staged release as the answer to a later check', () => {
    const h = harness()
    h.controller.check(true)
    h.handlers.available('0.4.0')
    h.controller.download()
    h.handlers.downloaded('0.4.0')
    // electron-updater compares against the running build, so the next check
    // still reports 0.4.0 as newer. That release is what installs, so it is
    // re-announced rather than left without a terminal frame.
    h.controller.check(false)
    h.handlers.available('0.4.0')
    expect(h.frames.at(-1)).toEqual({ type: 'downloaded', version: '0.4.0' })
    expect(h.controller.download()).toEqual({
      started: false,
      reason: 'Ari 0.4.0 is already downloaded.',
    })
    expect(h.controller.install().started).toBe(true)
  })

  it('terminates a check the user asked for, so the UI leaves "checking"', () => {
    const h = harness()
    h.controller.check(true)
    h.handlers.available('0.4.0')
    h.controller.download()
    h.handlers.downloaded('0.4.0')
    h.controller.check(true)
    h.handlers.available('0.4.0')
    expect(h.frames.slice(-2)).toEqual([
      { type: 'checking', manual: true },
      { type: 'downloaded', version: '0.4.0' },
    ])
  })

  it('re-announces a staged release instead of reporting the build current', () => {
    const h = harness()
    h.controller.check(true)
    h.handlers.available('0.4.0')
    h.controller.download()
    h.handlers.downloaded('0.4.0')
    h.controller.check(false)
    h.handlers.notAvailable()
    // `none` would wipe the staged version in the renderer and claim the build
    // is current, while install-on-quit still applies 0.4.0.
    expect(h.frames.at(-1)).toEqual({ type: 'downloaded', version: '0.4.0' })
    expect(h.frames.some((frame) => frame.type === 'none')).toBe(false)
  })

  it('keeps the staged release when a check finds a newer one', () => {
    const h = harness()
    h.controller.check(true)
    h.handlers.available('0.4.0')
    h.controller.download()
    h.handlers.downloaded('0.4.0')
    // 0.5.0 is newer, but 0.4.0 is the installer on disk and what
    // install-on-quit will apply: offering a download that discards it would
    // advertise a replacement the controller then refuses.
    h.controller.check(false)
    h.handlers.available('0.5.0')
    expect(h.frames.at(-1)).toEqual({ type: 'downloaded', version: '0.4.0' })
    expect(h.controller.install().started).toBe(true)
    expect(h.controller.download()).toEqual({
      started: false,
      reason: 'Ari 0.4.0 is already downloaded.',
    })
  })

  it('replays an in-flight download to a late subscriber, not a fresh offer', () => {
    const h = harness()
    h.controller.check(true)
    h.handlers.available('0.4.0')
    h.controller.download()
    expect(h.controller.snapshot()).toEqual([{ type: 'download.started', version: '0.4.0' }])
    h.handlers.progress(41.6)
    expect(h.controller.snapshot()).toEqual([
      { type: 'download.started', version: '0.4.0' },
      { type: 'download.progress', percent: 42 },
    ])
  })

  it('keeps a failed background check out of the stream, and never announces it', async () => {
    const h = harness()
    h.fake.checkForUpdates.mockRejectedValue(new Error('offline'))
    h.controller.check(false)
    await flush()
    // Not even a `checking` frame: a silent failure can never clear one, so a
    // background check must not park the UI on a spinner.
    expect(h.frames).toEqual([])
  })

  it('surfaces a failed check the user asked for', async () => {
    const h = harness()
    h.fake.checkForUpdates.mockRejectedValue(new Error('offline'))
    h.controller.check(true)
    await flush()
    expect(h.frames.at(-1)).toEqual({ type: 'error', message: 'offline' })
  })

  it('ends a check that settles without a verdict instead of holding it open', async () => {
    const h = harness()
    h.fake.checkForUpdates.mockResolvedValue(null)
    h.controller.check(true)
    await flush()
    // electron-updater resolves without emitting anything when it is inactive.
    // Left open that would keep the spinner up and refuse every later check.
    expect(h.frames.at(-1)).toEqual({
      type: 'error',
      message: 'The update check ended without a result.',
    })
    expect(h.controller.check(true).started).toBe(true)
  })

  it('surfaces a download failure and lets the user retry', async () => {
    const h = harness()
    h.fake.downloadUpdate.mockRejectedValue(new Error('connection reset'))
    h.controller.check(true)
    h.handlers.available('0.4.0')
    h.controller.download()
    await flush()
    expect(h.frames.at(-1)).toEqual({ type: 'error', message: 'connection reset' })
    expect(h.controller.download()).toEqual({ started: true, reason: null })
  })

  it('reports a caught quitAndInstall failure instead of throwing', () => {
    const h = harness()
    h.fake.quitAndInstall.mockImplementation(() => {
      throw new Error('installer missing')
    })
    h.controller.check(true)
    h.handlers.available('0.4.0')
    h.controller.download()
    h.handlers.downloaded('0.4.0')
    expect(h.controller.install()).toEqual({ started: false, reason: 'installer missing' })
    expect(h.frames.at(-1)).toEqual({ type: 'error', message: 'installer missing' })
  })

  it('refuses every step on a disabled build', () => {
    const h = harness(false)
    const reason = 'Updates are only available in installed builds.'
    expect(h.controller.check(true)).toEqual({ started: false, reason })
    expect(h.controller.download()).toEqual({ started: false, reason })
    expect(h.controller.install()).toEqual({ started: false, reason })
    expect(h.fake.checkForUpdates).not.toHaveBeenCalled()
  })

  it('arms the schedule once, and never on a disabled build', () => {
    vi.useFakeTimers()
    const h = harness()
    h.controller.start()
    h.controller.start()
    vi.advanceTimersByTime(8_000)
    expect(h.fake.checkForUpdates).toHaveBeenCalledTimes(1)

    const off = harness(false)
    off.controller.start()
    vi.advanceTimersByTime(8_000)
    expect(off.fake.checkForUpdates).not.toHaveBeenCalled()
  })

  it('replays only what a late subscriber still needs to know', () => {
    const h = harness()
    expect(h.controller.snapshot()).toEqual([])
    h.controller.check(false)
    h.handlers.available('0.4.0')
    expect(h.controller.snapshot()).toEqual([
      { type: 'available', version: '0.4.0', currentVersion: '0.3.0' },
    ])
    h.controller.download()
    h.handlers.downloaded('0.4.0')
    expect(h.controller.snapshot()).toEqual([{ type: 'downloaded', version: '0.4.0' }])
  })
})
