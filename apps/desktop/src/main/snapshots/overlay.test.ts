// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'

const electron = vi.hoisted(() => ({
  windows: [] as Array<{
    options: Record<string, unknown>
    showInactive: ReturnType<typeof vi.fn>
    hide: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    setBounds: ReturnType<typeof vi.fn>
    setIgnoreMouseEvents: ReturnType<typeof vi.fn>
    destroyed: boolean
    executeJavaScript: ReturnType<typeof vi.fn>
  }>,
}))
vi.mock('electron', () => ({
  BrowserWindow: class {
    destroyed = false
    showInactive = vi.fn()
    hide = vi.fn()
    focus = vi.fn()
    setAlwaysOnTop = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setBounds = vi.fn((bounds: Record<string, number>) => {
      this.bounds = { ...bounds }
    })
    executeJavaScript = vi.fn<(...args: unknown[]) => Promise<void>>((script: unknown) =>
      String(script).includes('beginSnapshotFeedback')
        ? new Promise<void>(() => {})
        : Promise.resolve(),
    )
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      executeJavaScript: this.executeJavaScript,
    }
    bounds: Record<string, number>
    constructor(public options: Record<string, unknown>) {
      this.bounds = {
        x: options.x as number,
        y: options.y as number,
        width: options.width as number,
        height: options.height as number,
      }
      electron.windows.push(this)
    }
    getBounds() {
      return { ...this.bounds }
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
  image: 'data:image/jpeg;base64,aW1hZ2U=',
  bounds: { x: -1000, y: 100, width: 900, height: 500 },
}
it('uses a transparent click-through window, shows inactive and handles a monitor left of primary', async () => {
  const overlay = new SnapshotOverlay()
  overlay.show(capture, defaultSettings)
  await vi.waitFor(() => expect(electron.windows[0]?.showInactive).toHaveBeenCalledOnce())
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
  expect(window.focus).not.toHaveBeenCalled()
  expect(window.executeJavaScript.mock.calls[0]?.[0]).toContain('window.resetSnapshotFeedback')
  expect(window.executeJavaScript.mock.calls[1]?.[0]).toContain('window.beginSnapshotFeedback')
  expect(window.executeJavaScript.mock.calls[1]?.[0]).toContain('data:image/jpeg;base64,aW1hZ2U=')
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
it('reuses the pre-warmed window instead of creating one per capture', async () => {
  const overlay = new SnapshotOverlay()
  overlay.prepare()
  expect(electron.windows).toHaveLength(1)
  const window = electron.windows[0]!
  window.executeJavaScript.mockResolvedValue(undefined)
  expect(window.options).toMatchObject({ show: false })
  overlay.show(capture, defaultSettings)
  await vi.waitFor(() => expect(window.showInactive).toHaveBeenCalledOnce())
  overlay.show({ ...capture, id: 'second' }, defaultSettings)
  expect(electron.windows).toHaveLength(1)
  expect(window.destroyed).toBe(false)
  overlay.dispose()
  expect(window.destroyed).toBe(true)
})
it('hides orphaned feedback on deadline without destroying the reused window', async () => {
  vi.useFakeTimers()
  const overlay = new SnapshotOverlay()
  overlay.show(capture, defaultSettings)
  await vi.advanceTimersByTimeAsync(0)
  const window = electron.windows[0]!
  expect(window.hide).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5000)
  expect(window.hide).toHaveBeenCalled()
  expect(window.destroyed).toBe(false)
  overlay.dispose()
})
it('hides visible feedback before the next capture so it cannot appear in the frame', async () => {
  vi.useFakeTimers()
  const overlay = new SnapshotOverlay()
  overlay.show(capture, defaultSettings)
  await vi.advanceTimersByTimeAsync(0)
  const window = electron.windows[0]!
  overlay.hide()
  expect(window.hide).toHaveBeenCalledOnce()
  overlay.dispose()
})
