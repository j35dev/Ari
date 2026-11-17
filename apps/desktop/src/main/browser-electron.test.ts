// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import {
  AGENT_TAB_IDLE_MS,
  AGENT_TAB_WAKE_MS,
  CAPTURE_ATTEMPTS,
  CAPTURE_RETRY_MS,
  INPUT_FOCUS_HOLD_MS,
  createElectronBrowserGuest,
  hostedBrowserGuestFactory,
} from './browser-electron'

const mocks = vi.hoisted(() => {
  const views: WebContentsView[] = []
  /** The webContents holding keyboard focus; focus() moves it, like Chromium. */
  const focus = { current: null as unknown }
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
      isFocused: vi.fn((): boolean => focus.current === this.webContents),
      focus: vi.fn(() => {
        focus.current = this.webContents
      }),
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
  return { views, focus, WebContentsView, BrowserWindow }
})

vi.mock('electron', () => ({
  WebContentsView: mocks.WebContentsView,
  BrowserWindow: mocks.BrowserWindow,
}))

function hostWindow(): BrowserWindow {
  const shell = {
    focus: vi.fn(() => {
      mocks.focus.current = shell
    }),
    isFocused: () => mocks.focus.current === shell,
    isDestroyed: () => false,
  }
  return {
    contentView: { children: [], addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: shell,
    isDestroyed: () => false,
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    isFocused: vi.fn(() => true),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as BrowserWindow
}

/** Calls the guest's listener for a webContents event, as Electron would. */
function emit(
  wc: InstanceType<typeof mocks.WebContentsView>['webContents'],
  name: string,
  ...args: unknown[]
): void {
  const listener = wc.on.mock.calls.find(([event]) => event === name)?.[1] as
    ((...args: unknown[]) => void) | undefined
  if (listener === undefined) throw new Error(`no ${name} listener`)
  listener(...args)
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
  mocks.focus.current = null
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
  it.each(['hide', 'minimize', 'blur'] as const)(
    'keeps a placed panel capturable when its host emits %s',
    async (event) => {
      vi.useFakeTimers()
      const win = hostWindow()
      const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
      const wc = firstView().webContents
      guest.setVisible(true)
      expect(wc.endFrameSubscription).toHaveBeenCalledOnce()

      if (event === 'hide') vi.mocked(win.isVisible).mockReturnValue(false)
      if (event === 'minimize') vi.mocked(win.isMinimized).mockReturnValue(true)
      if (event === 'blur') vi.mocked(win.isFocused).mockReturnValue(false)
      const listeners = vi.mocked(win.on).mock.calls as unknown as Array<[string, () => void]>
      const update = listeners.find(([name]) => name === event)?.[1]
      if (update === undefined) throw new Error(`no ${event} listener`)
      update()
      expect(wc.beginFrameSubscription).toHaveBeenCalledTimes(2)
      await guest.executeJavaScript('1')
      expect(wc.setBackgroundThrottling).toHaveBeenLastCalledWith(false)

      vi.mocked(win.isVisible).mockReturnValue(true)
      vi.mocked(win.isMinimized).mockReturnValue(false)
      vi.mocked(win.isFocused).mockReturnValue(true)
      update()
      expect(wc.endFrameSubscription).toHaveBeenCalledTimes(2)
      guest.destroy()
      expect(win.removeListener).toHaveBeenCalledWith(event, update)
    },
  )

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

  it('waits for a fresh frame after a hidden load but not after a visible one', async () => {
    vi.useFakeTimers()
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    let loaded = false

    void guest.loadURL('https://example.com/hidden').then(() => {
      loaded = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(loaded).toBe(false)
    const frameCallback = firstView().webContents.beginFrameSubscription.mock.calls.at(-1)?.[1] as
      ((image: { isEmpty(): boolean }) => void) | undefined
    if (frameCallback === undefined) throw new Error('no frame subscriber')
    frameCallback({ isEmpty: () => true })
    await vi.advanceTimersByTimeAsync(0)
    expect(loaded).toBe(false)
    deliverFrame()
    await vi.advanceTimersByTimeAsync(0)
    expect(loaded).toBe(true)

    // A shown page has no frame subscription, so no frame will ever arrive.
    guest.setVisible(true)
    loaded = false
    void guest.loadURL('https://example.com/visible').then(() => {
      loaded = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(loaded).toBe(true)
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

  it('waits through empty Windows startup captures until the page has rendered', async () => {
    vi.useFakeTimers()
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const wc = firstView().webContents
    const empty = {
      getSize: () => ({ width: 0, height: 0 }),
      resize: vi.fn(),
      toJPEG: () => Buffer.alloc(0),
      toPNG: () => Buffer.alloc(0),
    }
    for (let attempt = 0; attempt < 8; attempt++) wc.capturePage.mockResolvedValueOnce(empty)

    const shot = guest.capturePage(undefined, 'jpeg')
    await vi.advanceTimersByTimeAsync(CAPTURE_RETRY_MS * 8)
    expect((await shot)?.toString()).toBe('jpeg')
    expect(wc.capturePage).toHaveBeenCalledTimes(9)
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

  it('drops a hidden-page frame once the page is shown to the user', async () => {
    vi.useFakeTimers()
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const image = deliverFrame('before-showing')
    firstView().webContents.capturePage.mockRejectedValue(new Error('no copy surface'))

    guest.setVisible(true)
    const shot = guest.capturePage()
    await vi.advanceTimersByTimeAsync(CAPTURE_RETRY_MS * CAPTURE_ATTEMPTS)
    expect(await shot).toBeNull()
    expect(image.toPNG).not.toHaveBeenCalled()
  })
})

describe('guest input', () => {
  /** A host window whose shell (the chat composer) has keyboard focus. */
  function focusedShell(): BrowserWindow {
    const win = hostWindow()
    win.webContents.focus()
    vi.mocked(win.webContents.focus).mockClear()
    return win
  }

  it.each(['key', 'pointer'])(
    'focuses a hidden agent page for %s input and gives focus back once input stops',
    async (kind) => {
      vi.useFakeTimers()
      const win = focusedShell()
      const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
      const wc = firstView().webContents

      if (kind === 'key') {
        guest.sendKey('a', 'down', [])
        guest.sendKey('a', 'up', [])
      } else guest.sendMouse('move', 20, 30, 'left', [])

      const focused = wc.focus.mock.invocationCallOrder[0]
      const sent = wc.sendInputEvent.mock.invocationCallOrder[0]
      if (focused === undefined || sent === undefined) throw new Error('page was not focused')
      expect(focused).toBeLessThan(sent)
      // No blur between the events of one gesture.
      expect(win.webContents.focus).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(INPUT_FOCUS_HOLD_MS - 1)
      expect(win.webContents.focus).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(win.webContents.focus).toHaveBeenCalledOnce()
    },
  )

  it('keeps a held key focused across tool calls until it is released', async () => {
    vi.useFakeTimers()
    const win = focusedShell()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())

    guest.sendKey('ArrowRight', 'down', [])
    await vi.advanceTimersByTimeAsync(INPUT_FOCUS_HOLD_MS * 10)
    guest.sendKey(' ', 'down', [])
    guest.sendKey(' ', 'up', [])
    await vi.advanceTimersByTimeAsync(INPUT_FOCUS_HOLD_MS * 10)
    expect(win.webContents.focus).not.toHaveBeenCalled()
    expect(firstView().webContents.focus).toHaveBeenCalledOnce()

    guest.sendKey('ArrowRight', 'up', [])
    await vi.advanceTimersByTimeAsync(INPUT_FOCUS_HOLD_MS)
    expect(win.webContents.focus).toHaveBeenCalledOnce()
  })

  it('keeps a drag split over several calls focused until the button is released', async () => {
    vi.useFakeTimers()
    const win = focusedShell()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())

    guest.sendMouse('down', 20, 30, 'left', [])
    await vi.advanceTimersByTimeAsync(INPUT_FOCUS_HOLD_MS * 4)
    guest.sendMouse('move', 40, 50, 'left', [])
    await vi.advanceTimersByTimeAsync(INPUT_FOCUS_HOLD_MS * 4)
    expect(win.webContents.focus).not.toHaveBeenCalled()

    guest.sendMouse('up', 40, 50, 'left', [])
    await vi.advanceTimersByTimeAsync(INPUT_FOCUS_HOLD_MS)
    expect(win.webContents.focus).toHaveBeenCalledOnce()
  })

  it('gives focus back to another visible native page that had it', async () => {
    vi.useFakeTimers()
    const win = hostWindow()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    const inspector = createElectronBrowserGuest(win, 'inspector', vi.fn())
    inspector.setVisible(true)
    const peer = mocks.views[1]
    if (peer === undefined) throw new Error('no inspector view')
    peer.webContents.focus()
    peer.webContents.focus.mockClear()
    Object.defineProperty(win.contentView, 'children', { value: [...mocks.views] })

    guest.sendKey('a', 'down', [])
    guest.sendKey('a', 'up', [])
    await vi.advanceTimersByTimeAsync(INPUT_FOCUS_HOLD_MS)
    expect(peer.webContents.focus).toHaveBeenCalledOnce()
    expect(win.webContents.focus).not.toHaveBeenCalled()
  })

  it('gives the composer its focus back after input to a visible agent page', async () => {
    vi.useFakeTimers()
    const win = focusedShell()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    guest.setVisible(true)

    guest.sendMouse('down', 20, 30, 'left', [])
    guest.sendMouse('up', 20, 30, 'left', [])
    expect(firstView().webContents.focus).toHaveBeenCalledOnce()
    expect(firstView().webContents.sendInputEvent).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(INPUT_FOCUS_HOLD_MS)
    expect(win.webContents.focus).toHaveBeenCalledOnce()
  })

  it('leaves focus on a page the user had already focused', async () => {
    vi.useFakeTimers()
    const win = hostWindow()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    guest.setVisible(true)
    const wc = firstView().webContents
    wc.focus()
    wc.focus.mockClear()

    guest.sendKey('a', 'down', [])
    guest.sendKey('a', 'up', [])
    await vi.advanceTimersByTimeAsync(INPUT_FOCUS_HOLD_MS * 2)
    expect(wc.focus).not.toHaveBeenCalled()
    expect(win.webContents.focus).not.toHaveBeenCalled()
  })

  it('returns focus at once, without delivering it, when the user types during the loan', () => {
    const win = focusedShell()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    const wc = firstView().webContents
    const agentKey = { preventDefault: vi.fn() }
    // Electron raises before-input-event inside sendInputEvent for synthetic keys.
    wc.sendInputEvent.mockImplementation(() => emit(wc, 'before-input-event', agentKey, {}))

    guest.sendKey('ArrowRight', 'down', [])
    expect(agentKey.preventDefault).not.toHaveBeenCalled()
    expect(win.webContents.focus).not.toHaveBeenCalled()

    const userKey = { preventDefault: vi.fn() }
    emit(wc, 'before-input-event', userKey, {})
    expect(userKey.preventDefault).toHaveBeenCalledOnce()
    expect(win.webContents.focus).toHaveBeenCalledOnce()
  })

  it('leaves the user keys alone on a page they focused themselves', () => {
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const wc = firstView().webContents
    guest.setVisible(true)
    wc.focus()
    guest.sendKey('a', 'down', [])

    const userKey = { preventDefault: vi.fn() }
    emit(wc, 'before-input-event', userKey, {})
    expect(userKey.preventDefault).not.toHaveBeenCalled()
  })

  it('ends the loan when the user clicks elsewhere', () => {
    const win = focusedShell()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    const wc = firstView().webContents
    guest.setVisible(true)
    guest.sendKey('ArrowRight', 'down', [])

    // The user clicks the shell, then back into the page, and types there.
    mocks.focus.current = win.webContents
    emit(wc, 'blur')
    mocks.focus.current = wc
    const userKey = { preventDefault: vi.fn() }
    emit(wc, 'before-input-event', userKey, {})
    expect(userKey.preventDefault).not.toHaveBeenCalled()
    expect(win.webContents.focus).not.toHaveBeenCalled()
  })

  it.each(['hidden', 'destroyed'])('gives focus back at once when the page is %s', (how) => {
    const win = focusedShell()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    guest.setVisible(true)
    guest.sendKey('ArrowRight', 'down', [])

    if (how === 'hidden') guest.setVisible(false)
    else guest.destroy()
    expect(win.webContents.focus).toHaveBeenCalledOnce()
  })

  it('gives focus back even when hidden agent input throws', async () => {
    vi.useFakeTimers()
    const win = focusedShell()
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    firstView().webContents.sendInputEvent.mockImplementation(() => {
      throw new Error('input failed')
    })

    expect(() => guest.sendKey('a', 'down', [])).toThrow('input failed')
    await vi.advanceTimersByTimeAsync(INPUT_FOCUS_HOLD_MS)
    expect(win.webContents.focus).toHaveBeenCalledOnce()
  })

  it('keeps the old focus behaviour for the human-facing browser', async () => {
    vi.useFakeTimers()
    const win = focusedShell()
    const guest = createElectronBrowserGuest(win, 'inspector', vi.fn())
    guest.setVisible(true)

    guest.sendKey('a', 'down', [])
    guest.sendKey('a', 'up', [])
    await vi.advanceTimersByTimeAsync(INPUT_FOCUS_HOLD_MS * 2)
    expect(firstView().webContents.focus).toHaveBeenCalledOnce()
    expect(win.webContents.focus).not.toHaveBeenCalled()
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
