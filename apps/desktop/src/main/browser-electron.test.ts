// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import {
  AGENT_TAB_FRAME_RATE,
  AGENT_TAB_IDLE_MS,
  AGENT_TAB_WAKE_MS,
  createElectronBrowserGuest,
  hostedBrowserGuestFactory,
} from './browser-electron'

const mocks = vi.hoisted(() => {
  const views: {
    webPreferences: Record<string, unknown>
    webContents: WebContentsView['webContents']
  }[] = []
  class WebContentsView {
    readonly webContents = {
      getUserAgent: () => 'Mozilla/5.0 Electron/43.4.1',
      setUserAgent: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      setFrameRate: vi.fn(),
      startPainting: vi.fn(),
      stopPainting: vi.fn(),
      isDestroyed: () => false,
      isFocused: () => true,
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
      views.push({ webPreferences: options.webPreferences, webContents: this.webContents })
    }
    setBounds = vi.fn()
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
  return { contentView: { addChildView: vi.fn() } } as unknown as BrowserWindow
}

afterEach(() => {
  mocks.views.length = 0
})

describe('createElectronBrowserGuest rendering', () => {
  it('renders agent tabs offscreen so they paint while never shown', () => {
    createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())

    expect(mocks.views[0]?.webPreferences).toMatchObject({ offscreen: true, sandbox: true })
  })

  it('keeps the inspector a normal on-screen view', () => {
    createElectronBrowserGuest(hostWindow(), 'inspector', vi.fn())

    expect(mocks.views[0]?.webPreferences).toMatchObject({ offscreen: false, sandbox: true })
  })
})

describe('agent tab painting', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('paints offscreen agent tabs at a reduced frame rate', () => {
    createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    createElectronBrowserGuest(hostWindow(), 'inspector', vi.fn())

    expect(mocks.views[0]?.webContents.setFrameRate).toHaveBeenCalledWith(AGENT_TAB_FRAME_RATE)
    expect(mocks.views[1]?.webContents.setFrameRate).not.toHaveBeenCalled()
  })

  it('stops painting an idle agent tab and restarts before the next action', async () => {
    vi.useFakeTimers()
    const guest = createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())
    const wc = mocks.views[0]?.webContents
    if (wc === undefined) throw new Error('no view')

    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS - 1)
    expect(wc.stopPainting).not.toHaveBeenCalled()
    // A tool action resets the idle clock.
    guest.sendKey('a', 'down', [])
    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS - 1)
    expect(wc.stopPainting).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(wc.stopPainting).toHaveBeenCalledTimes(1)
    expect(wc.startPainting).not.toHaveBeenCalled()

    // A screenshot wakes it and waits for a fresh frame before capturing.
    const shot = guest.capturePage(undefined, 'jpeg')
    expect(wc.startPainting).toHaveBeenCalledTimes(1)
    expect(wc.capturePage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AGENT_TAB_WAKE_MS)
    expect((await shot)?.toString()).toBe('jpeg')

    // Awake actions do not restart painting again; idling stops it again.
    await guest.executeJavaScript('1')
    void guest.loadURL('https://example.com')
    expect(wc.startPainting).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS)
    expect(wc.stopPainting).toHaveBeenCalledTimes(2)
    guest.sendMouse('move', 1, 1, 'left', [])
    expect(wc.startPainting).toHaveBeenCalledTimes(2)
  })

  it('never stops painting the inspector', async () => {
    vi.useFakeTimers()
    createElectronBrowserGuest(hostWindow(), 'inspector', vi.fn())

    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS * 2)

    expect(mocks.views[0]?.webContents.stopPainting).not.toHaveBeenCalled()
  })

  it('cancels the idle timer when the tab is destroyed', async () => {
    vi.useFakeTimers()
    const win = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
    } as unknown as BrowserWindow
    const guest = createElectronBrowserGuest(win, 'agent:sess-a', vi.fn())
    const wc = mocks.views[0]?.webContents
    if (wc === undefined) throw new Error('no view')

    guest.destroy()
    await vi.advanceTimersByTimeAsync(AGENT_TAB_IDLE_MS)

    expect(wc.stopPainting).not.toHaveBeenCalled()
  })
})

describe('hostedBrowserGuestFactory', () => {
  it('passes the tab id through so agent tabs from the service factory render offscreen', () => {
    mocks.BrowserWindow.fromWebContents.mockReturnValue(hostWindow())
    const createGuest = hostedBrowserGuestFactory({} as WebContents)

    createGuest('agent:sess-a', vi.fn())
    createGuest('inspector', vi.fn())

    expect(mocks.views.map((v) => v.webPreferences.offscreen)).toEqual([true, false])
  })

  it('refuses when the host window is gone', () => {
    mocks.BrowserWindow.fromWebContents.mockReturnValue(null)

    expect(() => hostedBrowserGuestFactory({} as WebContents)('agent:sess-a', vi.fn())).toThrow(
      'browser host window is gone',
    )
  })
})
