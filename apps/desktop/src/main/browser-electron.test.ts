// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { createElectronBrowserGuest } from './browser-electron'

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
  return { views, WebContentsView }
})

vi.mock('electron', () => ({ WebContentsView: mocks.WebContentsView }))

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
