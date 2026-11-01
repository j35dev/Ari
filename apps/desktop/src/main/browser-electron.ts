import { BrowserWindow, WebContentsView, screen, type WebContents } from 'electron'
import { encodeCapture } from './browser-capture'
import { ConsoleBuffer } from './browser-console'
import type { BrowserGuest, BrowserGuestFactory, PointerButton } from './browser-service'
import { isBrowserNavigable } from './browser-url'

export const BROWSER_PARTITION = 'persist:ari-browser'

/** True when this webContents is the in-app browser, not the ADE shell. */
export function isBrowserGuest(contents: WebContents): boolean {
  const session = contents.session as unknown as { partition?: string }
  return session.partition === BROWSER_PARTITION
}

/** sendInputEvent takes accelerator key names, so map DOM names like ArrowRight and " ". */
function acceleratorKey(key: string): string {
  if (key === ' ') return 'Space'
  return key.startsWith('Arrow') ? key.slice('Arrow'.length) : key
}

/**
 * BrowserService guest factory for the window hosting `contents`. The tab id
 * must reach createElectronBrowserGuest: it decides whether the tab renders
 * offscreen.
 */
export function hostedBrowserGuestFactory(contents: WebContents): BrowserGuestFactory {
  return (tabId, onUpdated) => {
    const win = BrowserWindow.fromWebContents(contents)
    if (win === null) throw new Error('browser host window is gone')
    return createElectronBrowserGuest(win, tabId, onUpdated)
  }
}

/**
 * Chromium guest for one in-app tab. Isolated partition, sandboxed, no Node.
 * Popups navigate the same view instead of spawning windows.
 *
 * Agent tabs are never laid out, and a hidden view does not paint: rAF stops
 * and capturePage throws (#432). So they render offscreen, which keeps them
 * painting without ever drawing into the window. Their viewport follows the
 * window's size. The inspector stays a normal view because the user sees it.
 *
 * Offscreen rendering defaults to scale 1, so agent tabs take the scale of the
 * display the window is on when created (#443). They don't follow the window
 * to a display with a different scale.
 */
export function createElectronBrowserGuest(
  win: BrowserWindow,
  tabId: string,
  onUpdated: () => void,
): BrowserGuest {
  const view = new WebContentsView({
    webPreferences: {
      offscreen: tabId.startsWith('agent:') && {
        deviceScaleFactor: screen.getDisplayMatching(win.getBounds()).scaleFactor,
      },
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
  let heldButton: PointerButton | null = null
  wc.setUserAgent(wc.getUserAgent().replace(/\sElectron\/\S+/g, ''))

  const emit = (): void => onUpdated()
  const consoleBuffer = new ConsoleBuffer()
  wc.on('console-message', (details) =>
    consoleBuffer.push({
      level: details.level,
      message: details.message,
      sourceUrl: details.sourceId,
    }),
  )
  wc.on('did-navigate', () => consoleBuffer.clear())
  wc.on('did-navigate', emit)
  wc.on('did-navigate-in-page', emit)
  wc.on('page-title-updated', emit)
  wc.on('did-start-loading', emit)
  wc.on('did-stop-loading', emit)
  wc.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) emit()
  })

  const blockDisallowed = (event: { preventDefault(): void }, url: string): void => {
    if (!isBrowserNavigable(url)) event.preventDefault()
  }
  // will-navigate misses 3xx. A guest redirect to file: or an OS protocol
  // has to be cancelled on will-redirect, same as the shell guard.
  wc.on('will-navigate', blockDisallowed)
  wc.on('will-redirect', blockDisallowed)
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
    consoleEntries: () => consoleBuffer.entries(),
    capturePage: async (rect, format = 'png', size) => {
      try {
        return encodeCapture(await wc.capturePage(rect), format, size)
      } catch {
        return null
      }
    },
    sendKey: (key, phase, modifiers) => {
      if (!wc.isFocused()) wc.focus()
      wc.sendInputEvent({
        type: phase === 'down' ? 'keyDown' : 'keyUp',
        keyCode: acceleratorKey(key),
        modifiers,
      })
    },
    sendMouse: (phase, x, y, button, modifiers) => {
      if (!wc.isFocused()) wc.focus()
      if (phase === 'down' || phase === 'up') {
        wc.sendInputEvent({
          type: phase === 'down' ? 'mouseDown' : 'mouseUp',
          x,
          y,
          button,
          clickCount: 1,
          modifiers,
        })
        heldButton = phase === 'down' ? button : null
        return
      }
      wc.sendInputEvent({
        type: 'mouseMove',
        x,
        y,
        modifiers:
          heldButton === null ? modifiers : [...modifiers, `${heldButton}buttondown` as const],
      })
    },
    setBounds: (bounds) => view.setBounds(bounds),
    setVisible: (visible) => view.setVisible(visible),
    destroy: () => {
      if (!win.isDestroyed()) win.contentView.removeChildView(view)
      if (!wc.isDestroyed()) wc.close()
    },
  }
}
