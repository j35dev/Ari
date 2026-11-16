// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import {
  AGENT_TAB_IDLE_MS,
  AGENT_TAB_WAKE_MS,
  CAPTURE_ATTEMPTS,
  CAPTURE_RETRY_MS,
  createElectronBrowserGuest,
  hostedBrowserGuestFactory,
} from './browser-electron'

const mocks = vi.hoisted(() => {
  const views: WebContentsView[] = []
  class WebContentsView {
    readonly webPreferences: Record<string, unknown>
    private bounds = { x: 0, y: 0, width: 0, height: 0 }
    readonly webContents = {
      getUserAgent: () => 'Mozilla/5.0 Electron/43.4.1',
      setUserAgent: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      beginFrameSubscription: vi.fn(),
      endFrameSubscription: vi.fn(),
      isDestroyed: () => false,
      isFocused: vi.fn(() => false),
      focus: vi.fn(),
      sendInputEvent: vi.fn(),
      close: vi.fn(),
      loadURL: vi.fn(async () => {}),
      executeJavaScript: vi.fn(async () => null),
      capturePage: vi.fn(async () => ({
        getSize: () => ({ width: 10, height: 10 }),
        resize: vi.fn(),
        toJPEG: () => Buffer.from('jpeg'),
        toPNG: () => Buffer.from('png'),
      })),
    }
    constructor(options: { webPreferences: Record<string, unknown> }) {
      this.webPreferences = options.webPreferences
      views.push(this)
    }
    getBounds = () => this.bounds
    setBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => {
      this.bounds = bounds
    })
    setVisible = vi.fn()
  }
  const BrowserWindow = { fromWebContents: vi.fn() }
  return { views, WebContentsView, BrowserWindow }
})

vi.mock('electron', () => ({
  WebContentsView: mocks.WebContentsView,
  BrowserWindow: mocks.BrowserWindow,
}))

function hostWindow(): BrowserWindow {
  return {
    contentView: { children: [], addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { focus: vi.fn(), isDestroyed: () => false },
    isDestroyed: () => false,
  } as unknown as BrowserWindow
}

function firstView(): InstanceType<typeof mocks.WebContentsView> {
  const view = mocks.views[0]
  if (view === undefined) throw new Error('no view')
  return view
}

function deliverFrame(label = 'cached') {
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 800, height: 600 }),
    resize: vi.fn(),
    toJPEG: vi.fn(() => Buffer.from(`${label}-jpeg`)),
    toPNG: vi.fn(() => Buffer.from(`${label}-png`)),
  }
  const callback = firstView().webContents.beginFrameSubscription.mock.calls.at(-1)?.[1] as
    ((frame: typeof image) => void) | undefined
  if (callback === undefined) throw new Error('no frame subscriber')
  callback(image)
  return image
}

afterEach(() => {
  mocks.views.length = 0
  vi.useRealTimers()
})

describe('createElectronBrowserGuest rendering', () => {
  it('keeps an agent tab native and capturing while hidden before its panel opens', () => {
    const win = hostWindow()
    createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    const view = firstView()

    expect(view.webPreferences).toMatchObject({
      offscreen: false,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })
    expect(win.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setVisible).toHaveBeenCalledWith(false)
    expect(view.webContents.beginFrameSubscription).toHaveBeenCalledWith(
      false,
      expect.any(Function),
    )
    expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 800, height: 600 })
  })

  it('shows and hides the same live agent page without recreating its view', () => {
    const win = hostWindow()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    const view = firstView()

    guest.setBounds({ x: 480, y: 96, width: 650, height: 420 })
    guest.setVisible(true)
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 480, y: 96, width: 650, height: 420 })

    guest.setVisible(false)
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    expect(win.contentView.addChildView).toHaveBeenCalledTimes(2)
    expect(view.webContents.close).not.toHaveBeenCalled()
    expect(mocks.views).toHaveLength(1)
  })

  it('returns keyboard focus to the shell when a focused agent page is covered', () => {
    const win = hostWindow()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    guest.setVisible(true)
    firstView().webContents.isFocused.mockReturnValue(true)

    guest.setVisible(false)
    expect(win.webContents.focus).toHaveBeenCalledOnce()
  })

  it('keeps the inspector a normal view that hides when its panel closes', () => {
    const guest = createElectronBrowserGuest(hostWindow(), 'inspector', vi.fn())
    const view = firstView()

    expect(view.webPreferences).toMatchObject({ offscreen: false, sandbox: true })
    expect(view.setVisible).toHaveBeenCalledWith(false)
    expect(view.webContents.beginFrameSubscription).not.toHaveBeenCalled()
    guest.setVisible(true)
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
    guest.setVisible(false)
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
  })
})

describe('agent tab throttling', () => {
  it('subscribes to hidden frames and releases the capturer while the page is visible', () => {
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const wc = firstView().webContents
    expect(wc.beginFrameSubscription).toHaveBeenCalledOnce()

    guest.setVisible(true)
    guest.setVisible(true)
    expect(wc.endFrameSubscription).toHaveBeenCalledOnce()
    expect(wc.beginFrameSubscription).toHaveBeenCalledOnce()

    guest.setVisible(false)
    guest.setVisible(false)
    expect(wc.beginFrameSubscription).toHaveBeenCalledTimes(2)
    expect(wc.endFrameSubscription).toHaveBeenCalledOnce()
  })

  it('throttles an idle hidden tab and wakes it before capturing a fresh frame', async () => {
    vi.useFakeTimers()
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const wc = firstView().webContents

    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS - 1)
    expect(wc.setBackgroundThrottling).not.toHaveBeenCalledWith(true)
    guest.sendKey('a', 'down', [])
    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS - 1)
    expect(wc.setBackgroundThrottling).not.toHaveBeenCalledWith(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
    expect(wc.endFrameSubscription).toHaveBeenCalledOnce()

    const shot = guest.capturePage(undefined, 'jpeg')
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(false)
    expect(wc.beginFrameSubscription).toHaveBeenCalledTimes(2)
    expect(wc.capturePage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AGENT_TAB_WAKE_MS)
    expect((await shot)?.toString()).toBe('jpeg')

    await guest.executeJavaScript('1')
    const navigation = guest.loadURL('https://example.com')
    await vi.advanceTimersByTimeAsync(1000)
    await navigation
    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS)
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
    expect(wc.endFrameSubscription).toHaveBeenCalledTimes(2)
    guest.sendMouse('move', 1, 1, 'left', [])
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(false)
    expect(wc.beginFrameSubscription).toHaveBeenCalledTimes(3)
  })

  it('keeps a visible agent tab awake even when no agent tool is used', async () => {
    vi.useFakeTimers()
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const wc = firstView().webContents
    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS)
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(true)

    guest.setVisible(true)
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(false)
    const captures = wc.beginFrameSubscription.mock.calls.length
    wc.setBackgroundThrottling.mockClear()
    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS * 2)
    expect(wc.setBackgroundThrottling).not.toHaveBeenCalledWith(true)
    expect(wc.beginFrameSubscription).toHaveBeenCalledTimes(captures)
  })

  it('lets a screenshot settle after a viewport read already woke the tab', async () => {
    vi.useFakeTimers()
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const wc = firstView().webContents
    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS)
    await guest.executeJavaScript('[innerWidth,innerHeight]')
    const shot = guest.capturePage(undefined, 'jpeg')
    expect(wc.capturePage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AGENT_TAB_WAKE_MS)
    expect((await shot)?.toString()).toBe('jpeg')
  })

  it('starts the idle clock when a visible agent tab is hidden', async () => {
    vi.useFakeTimers()
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const wc = firstView().webContents
    guest.setVisible(true)
    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS * 2)
    guest.setVisible(false)

    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS - 1)
    expect(wc.setBackgroundThrottling).not.toHaveBeenCalledWith(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
  })

  it('leaves the inspector throttling policy alone', async () => {
    vi.useFakeTimers()
    createElectronBrowserGuest(hostWindow(), 'inspector', vi.fn())
    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS * 2)

    expect(firstView().webContents.setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('cancels the idle clock and removes the view when the tab is destroyed', async () => {
    vi.useFakeTimers()
    const win = hostWindow()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    const view = firstView()

    guest.destroy()
    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS)
    expect(view.webContents.setBackgroundThrottling).not.toHaveBeenCalledWith(true)
    expect(view.webContents.endFrameSubscription).toHaveBeenCalledOnce()
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.close).toHaveBeenCalledOnce()
  })
})

describe('cached frame fallback', () => {
  it('uses a current subscription frame when a full native capture fails', async () => {
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const image = deliverFrame()
    firstView().webContents.capturePage.mockRejectedValue(new Error('no copy surface'))

    expect((await guest.capturePage())?.toString()).toBe('cached-png')
    expect((await guest.capturePage(undefined, 'jpeg'))?.toString()).toBe('cached-jpeg')
    expect(image.toPNG).toHaveBeenCalledOnce()
    expect(image.toJPEG).toHaveBeenCalledOnce()
  })

  it('invalidates a cached frame when navigation starts outside guest.loadURL', async () => {
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const image = deliverFrame('previous-page')
    const wc = firstView().webContents
    wc.capturePage.mockRejectedValue(new Error('no copy surface'))
    const loading = wc.on.mock.calls.find(([event]) => event === 'did-start-loading')?.[1] as
      (() => void) | undefined
    if (loading === undefined) throw new Error('no loading listener')

    loading()
    expect(await guest.capturePage()).toBeNull()
    expect(image.toPNG).not.toHaveBeenCalled()
    deliverFrame('current-page')
    expect((await guest.capturePage())?.toString()).toBe('current-page-png')
  })

  it('keeps a cached frame while moving but invalidates it when the viewport resizes', async () => {
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    deliverFrame()
    firstView().webContents.capturePage.mockRejectedValue(new Error('no copy surface'))

    guest.setBounds({ x: 400, y: 80, width: 800, height: 600 })
    expect((await guest.capturePage())?.toString()).toBe('cached-png')
    guest.setBounds({ x: 400, y: 80, width: 400, height: 300 })
    expect(await guest.capturePage()).toBeNull()
  })

  it('retries a native capture that fails before the hidden surface is copyable', async () => {
    vi.useFakeTimers()
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const wc = firstView().webContents
    wc.capturePage.mockRejectedValueOnce(new Error('UnknownVizError'))

    const shot = guest.capturePage(undefined, 'jpeg')
    await vi.advanceTimersByTimeAsync(CAPTURE_RETRY_MS)
    expect((await shot)?.toString()).toBe('jpeg')
    expect(wc.capturePage).toHaveBeenCalledTimes(2)
  })

  it('gives up after a bounded number of failed native captures', async () => {
    vi.useFakeTimers()
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const wc = firstView().webContents
    wc.capturePage.mockRejectedValue(new Error('UnknownVizError'))

    const shot = guest.capturePage()
    await vi.advanceTimersByTimeAsync(CAPTURE_RETRY_MS * CAPTURE_ATTEMPTS)
    expect(await shot).toBeNull()
    expect(wc.capturePage).toHaveBeenCalledTimes(CAPTURE_ATTEMPTS)
  })

  it('does not crop a device-pixel cached frame with a CSS-pixel capture rectangle', async () => {
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const image = deliverFrame()
    firstView().webContents.capturePage.mockRejectedValue(new Error('no copy surface'))

    expect(await guest.capturePage({ x: 20, y: 30, width: 100, height: 80 })).toBeNull()
    expect(image.toPNG).not.toHaveBeenCalled()
  })
})

describe('guest input', () => {
  it.each(['key', 'pointer'])('restores shell focus after hidden agent %s input', (kind) => {
    const win = hostWindow()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    const wc = firstView().webContents

    if (kind === 'key') guest.sendKey('a', 'down', [])
    else guest.sendMouse('down', 20, 30, 'left', [])

    expect(wc.sendInputEvent).toHaveBeenCalledOnce()
    expect(win.webContents.focus).toHaveBeenCalledOnce()
    const focused = wc.focus.mock.invocationCallOrder[0]
    const sent = wc.sendInputEvent.mock.invocationCallOrder[0]
    const restored = vi.mocked(win.webContents.focus).mock.invocationCallOrder[0]
    if (focused === undefined || sent === undefined || restored === undefined)
      throw new Error('native input focus was not restored')
    expect(focused).toBeLessThan(sent)
    expect(sent).toBeLessThan(restored)
  })

  it('preserves the focus of another visible native page during hidden agent input', () => {
    const win = hostWindow()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    const inspector = createElectronBrowserGuest(win, 'inspector', vi.fn())
    inspector.setVisible(true)
    const peer = mocks.views[1]
    if (peer === undefined) throw new Error('no inspector view')
    peer.webContents.isFocused.mockReturnValue(true)
    Object.defineProperty(win.contentView, 'children', { value: [...mocks.views] })

    guest.sendKey('a', 'down', [])
    expect(peer.webContents.focus).toHaveBeenCalledOnce()
    expect(win.webContents.focus).not.toHaveBeenCalled()
    expect(firstView().webContents.sendInputEvent).toHaveBeenCalledOnce()
  })

  it('keeps focus on a visible agent page during its input', () => {
    const win = hostWindow()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    guest.setVisible(true)

    guest.sendKey('a', 'down', [])
    guest.sendMouse('down', 20, 30, 'left', [])
    expect(firstView().webContents.focus).toHaveBeenCalled()
    expect(firstView().webContents.sendInputEvent).toHaveBeenCalledTimes(2)
    expect(win.webContents.focus).not.toHaveBeenCalled()
  })

  it('restores shell focus even when hidden agent input throws', () => {
    const win = hostWindow()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    firstView().webContents.sendInputEvent.mockImplementation(() => {
      throw new Error('input failed')
    })

    expect(() => guest.sendKey('a', 'down', [])).toThrow('input failed')
    expect(win.webContents.focus).toHaveBeenCalledOnce()
  })

  it('uses Chromium accelerator key names and preserves held buttons during a drag', () => {
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const wc = firstView().webContents

    guest.sendKey('ArrowRight', 'down', ['shift'])
    expect(wc.sendInputEvent).toHaveBeenLastCalledWith({
      type: 'keyDown',
      keyCode: 'Right',
      modifiers: ['shift'],
    })
    guest.sendKey(' ', 'up', [])
    expect(wc.sendInputEvent).toHaveBeenLastCalledWith({
      type: 'keyUp',
      keyCode: 'Space',
      modifiers: [],
    })

    guest.sendMouse('down', 20, 30, 'left', [])
    guest.sendMouse('move', 40, 50, 'left', ['ctrl'])
    expect(wc.sendInputEvent).toHaveBeenLastCalledWith({
      type: 'mouseMove',
      x: 40,
      y: 50,
      modifiers: ['ctrl', 'leftbuttondown'],
    })
    guest.sendMouse('up', 40, 50, 'left', [])
    guest.sendMouse('move', 60, 70, 'left', [])
    expect(wc.sendInputEvent).toHaveBeenLastCalledWith({
      type: 'mouseMove',
      x: 60,
      y: 70,
      modifiers: [],
    })
  })
})

describe('hostedBrowserGuestFactory', () => {
  it('passes the tab id through so agent tabs stay native and unthrottled while active', () => {
    mocks.BrowserWindow.fromWebContents.mockReturnValue(hostWindow())
    const createGuest = hostedBrowserGuestFactory({} as WebContents)
    createGuest('agent:sess-a', vi.fn())
    createGuest('inspector', vi.fn())

    expect(mocks.views.map((v) => v.webPreferences.offscreen)).toEqual([false, false])
    expect(mocks.views[0]?.setVisible).toHaveBeenCalledWith(false)
    expect(mocks.views[1]?.setVisible).toHaveBeenCalledWith(false)
    expect(mocks.views[0]?.webContents.beginFrameSubscription).toHaveBeenCalledOnce()
    expect(mocks.views[1]?.webContents.beginFrameSubscription).not.toHaveBeenCalled()
  })

  it('refuses when the host window is gone', () => {
    mocks.BrowserWindow.fromWebContents.mockReturnValue(null)

    expect(() => hostedBrowserGuestFactory({} as WebContents)('agent:sess-a', vi.fn())).toThrow(
      'browser host window is gone',
    )
  })
})
