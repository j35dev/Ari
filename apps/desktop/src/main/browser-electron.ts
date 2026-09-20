import { WebContentsView, type BrowserWindow } from 'electron'
import type { BrowserGuest } from './browser-service'
import { isBrowserNavigable } from './browser-url'

const PARTITION = 'persist:ari-browser'

/**
 * Chromium guest for one in-app tab. Isolated partition, sandboxed, no Node.
 * Popups navigate the same view instead of spawning windows.
 */
export function createElectronBrowserGuest(
  win: BrowserWindow,
  onUpdated: () => void,
): BrowserGuest {
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: PARTITION,
    },
  })
  win.contentView.addChildView(view)
  view.setVisible(false)
  const wc = view.webContents

  const emit = (): void => onUpdated()
  wc.on('did-navigate', emit)
  wc.on('did-navigate-in-page', emit)
  wc.on('page-title-updated', emit)
  wc.on('did-start-loading', emit)
  wc.on('did-stop-loading', emit)
  wc.on('did-fail-load', emit)

  wc.on('will-navigate', (event, url) => {
    if (!isBrowserNavigable(url)) event.preventDefault()
  })
  wc.setWindowOpenHandler(({ url }) => {
    if (isBrowserNavigable(url)) void wc.loadURL(url)
    return { action: 'deny' }
  })

  return {
    loadURL: (url) => wc.loadURL(url),
    goBack: () => {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    },
    goForward: () => {
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    },
    reload: () => wc.reload(),
    canGoBack: () => wc.navigationHistory.canGoBack(),
    canGoForward: () => wc.navigationHistory.canGoForward(),
    getURL: () => wc.getURL(),
    getTitle: () => wc.getTitle(),
    isLoading: () => wc.isLoading(),
    setBounds: (bounds) => view.setBounds(bounds),
    setVisible: (visible) => view.setVisible(visible),
    destroy: () => {
      if (!win.isDestroyed()) win.contentView.removeChildView(view)
      if (!wc.isDestroyed()) wc.close()
    },
  }
}
