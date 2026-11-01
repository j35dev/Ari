// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import { createElectronBrowserGuest, hostedBrowserGuestFactory } from './browser-electron'

const mocks = vi.hoisted(() => {
  const views: { webPreferences: Record<string, unknown> }[] = []
  class WebContentsView {
    readonly webContents = {
      getUserAgent: () => 'Mozilla/5.0 Electron/43.4.1',
      setUserAgent: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    }
    constructor(options: { webPreferences: Record<string, unknown> }) {
      views.push({ webPreferences: options.webPreferences })
    }
    setBounds = vi.fn()
    setVisible = vi.fn()
  }
  const BrowserWindow = { fromWebContents: vi.fn() }
  // Two side-by-side displays: a 1x one at x < 1920 and a 2x one right of it.
  const screen = {
    getDisplayMatching: (rect: { x: number }) => ({ scaleFactor: rect.x < 1920 ? 1 : 2 }),
  }
  return { views, WebContentsView, BrowserWindow, screen }
})

vi.mock('electron', () => ({
  WebContentsView: mocks.WebContentsView,
  BrowserWindow: mocks.BrowserWindow,
  screen: mocks.screen,
}))

function hostWindow(x = 0): BrowserWindow {
  return {
    contentView: { addChildView: vi.fn() },
    getBounds: () => ({ x, y: 0, width: 1280, height: 800 }),
  } as unknown as BrowserWindow
}

afterEach(() => {
  mocks.views.length = 0
})

describe('createElectronBrowserGuest rendering', () => {
  it('renders agent tabs offscreen so they paint while never shown', () => {
    createElectronBrowserGuest(hostWindow(), 'agent:sess-a', vi.fn())

    expect(mocks.views[0]?.webPreferences).toMatchObject({
      offscreen: { deviceScaleFactor: 1 },
      sandbox: true,
    })
  })

  it('keeps the inspector a normal on-screen view', () => {
    createElectronBrowserGuest(hostWindow(), 'inspector', vi.fn())

    expect(mocks.views[0]?.webPreferences).toMatchObject({ offscreen: false, sandbox: true })
  })
})

describe('hostedBrowserGuestFactory', () => {
  it('passes the tab id through so agent tabs from the service factory render offscreen', () => {
    mocks.BrowserWindow.fromWebContents.mockReturnValue(hostWindow())
    const createGuest = hostedBrowserGuestFactory({} as WebContents)

    createGuest('agent:sess-a', vi.fn())
    createGuest('inspector', vi.fn())

    expect(mocks.views.map((v) => v.webPreferences.offscreen)).toEqual([
      { deviceScaleFactor: 1 },
      false,
    ])
  })

  it('renders agent tabs at the scale of the display the host window is on', () => {
    mocks.BrowserWindow.fromWebContents.mockReturnValue(hostWindow(2000))
    const createGuest = hostedBrowserGuestFactory({} as WebContents)

    createGuest('agent:sess-a', vi.fn())

    expect(mocks.views[0]?.webPreferences.offscreen).toEqual({ deviceScaleFactor: 2 })
  })

  it('refuses when the host window is gone', () => {
    mocks.BrowserWindow.fromWebContents.mockReturnValue(null)

    expect(() => hostedBrowserGuestFactory({} as WebContents)('agent:sess-a', vi.fn())).toThrow(
      'browser host window is gone',
    )
  })
})
