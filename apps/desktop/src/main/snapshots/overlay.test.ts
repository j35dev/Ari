// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'

const electron = vi.hoisted(() => ({
  windows: [] as Array<{
    options: Record<string, unknown>
    showInactive: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    setIgnoreMouseEvents: ReturnType<typeof vi.fn>
    destroyed: boolean
    executeJavaScript: ReturnType<typeof vi.fn>
  }>,
}))
vi.mock('electron', () => ({
  BrowserWindow: class {
    destroyed = false
    showInactive = vi.fn()
    focus = vi.fn()
    setAlwaysOnTop = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    executeJavaScript = vi.fn<(...args: unknown[]) => Promise<void>>(
      () => new Promise<void>(() => {}),
    )
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      executeJavaScript: this.executeJavaScript,
    }
    constructor(public options: Record<string, unknown>) {
      electron.windows.push(this)
    }
    once = vi.fn()
    loadURL = vi.fn(async () => undefined)
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
    }
  },
  screen: {
    getAllDisplays: () => [
      { bounds: { x: -1280, y: 0, width: 1280, height: 720 } },
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ],
    getDisplayMatching: () => ({ workArea: { x: -1280, y: 0, width: 1280, height: 680 } }),
  },
  systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
}))
import { SnapshotOverlay } from './overlay'

afterEach(() => {
  electron.windows = []
  vi.useRealTimers()
})
const capture = {
  id: 'capture',
  dataBase64: 'aW1hZ2U=',
  bounds: { x: -1000, y: 100, width: 900, height: 500 },
}
it('uses a transparent click-through window, shows inactive and handles a monitor left of primary', async () => {
  vi.useFakeTimers()
  const overlay = new SnapshotOverlay()
  overlay.show(capture, defaultSettings)
  await Promise.resolve()
  const window = electron.windows[0]!
  expect(window.options).toMatchObject({
    x: -1280,
    y: 0,
    width: 3200,
    height: 1080,
    focusable: false,
    skipTaskbar: true,
    transparent: true,
  })
  expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
  expect(window.showInactive).toHaveBeenCalledOnce()
  expect(window.focus).not.toHaveBeenCalled()
  expect(window.executeJavaScript.mock.calls[0]?.[0]).toContain('window.beginSnapshotFeedback')
  overlay.dispose()
  expect(window.destroyed).toBe(true)
})
it('does not create an overlay when both feedback preferences are off', () => {
  const overlay = new SnapshotOverlay()
  overlay.show(capture, {
    ...defaultSettings,
    snapshots: { ...defaultSettings.snapshots, animation: false, sound: false },
  })
  expect(electron.windows).toHaveLength(0)
})
it('closes orphaned overlays on deadline and replaces the previous capture', async () => {
  vi.useFakeTimers()
  const overlay = new SnapshotOverlay()
  overlay.show(capture, defaultSettings)
  overlay.show({ ...capture, id: 'second' }, defaultSettings)
  expect(electron.windows[0]?.destroyed).toBe(true)
  await vi.advanceTimersByTimeAsync(5000)
  expect(electron.windows[1]?.destroyed).toBe(true)
})
