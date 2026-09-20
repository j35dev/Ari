import { WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import type { BrowserGuest } from './browser-service'
import { isBrowserNavigable } from './browser-url'

export const BROWSER_PARTITION = 'persist:ari-browser'

/** True when this webContents is the in-app browser, not the ADE shell. */
export function isBrowserGuest(contents: WebContents): boolean {
  const session = contents.session as unknown as { partition?: string }
  return session.partition === BROWSER_PARTITION
}

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
      partition: BROWSER_PARTITION,
    },
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 })
  view.setVisible(false)
  const wc = view.webContents
  wc.setUserAgent(wc.getUserAgent().replace(/\sElectron\/\S+/g, ''))

  const emit = (): void => onUpdated()
  wc.on('did-navigate', emit)
  wc.on('did-navigate-in-page', emit)
  wc.on('page-title-updated', emit)
  wc.on('did-start-loading', emit)
  wc.on('did-stop-loading', emit)
  wc.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) emit()
  })

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
    executeJavaScript: (code) => wc.executeJavaScript(code, true),
    capturePage: async (rect) => {
      try {
        const image = await wc.capturePage(rect)
        const png = image.toPNG()
        return png.length > 0 ? png : null
      } catch {
        return null
      }
    },
    setBounds: (bounds) => view.setBounds(bounds),
    setVisible: (visible) => view.setVisible(visible),
    destroy: () => {
      if (!win.isDestroyed()) win.contentView.removeChildView(view)
      if (!wc.isDestroyed()) wc.close()
    },
  }
}
