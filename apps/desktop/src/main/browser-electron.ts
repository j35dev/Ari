import { BrowserWindow, WebContentsView, type NativeImage, type WebContents } from 'electron'
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

/** A background agent tab with no browser tool use for this long may throttle. */
export const AGENT_TAB_IDLE_MS = 2 * 60_000
/** After painting restarts, a capture waits this long for a fresh frame. */
export const AGENT_TAB_WAKE_MS = 100
/**
 * On Linux a hidden native view delivers no subscription frames, and its first
 * capturePage can reject with UnknownVizError while Chromium makes the surface
 * copyable. Capture retries at this spacing, up to CAPTURE_ATTEMPTS times.
 */
export const CAPTURE_RETRY_MS = 50
export const CAPTURE_ATTEMPTS = 5
/**
 * Agent input borrows keyboard focus for the page and gives it back this long
 * after its last event, unless a key or mouse button is still held down.
 */
export const INPUT_FOCUS_HOLD_MS = 500

interface PaintControl {
  setBackgroundThrottling(allowed: boolean): void
  beginFrameSubscription(onlyDirty: boolean, callback: () => void): void
  endFrameSubscription(): void
  isDestroyed(): boolean
}

/**
 * Background tabs may throttle after idling. A visible page always keeps
 * painting, including while the user interacts without any browser tool calls.
 */
function idlePainter(
  wc: PaintControl,
  onFrame: () => void,
): {
  wake(): boolean
  settleDelay(): number
  present(visible: boolean): void
  subscribed(): boolean
  dispose(): void
} {
  let asleep = false
  let presented = false
  let subscribed = false
  let readyAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const capture = (active: boolean): void => {
    if (wc.isDestroyed() || subscribed === active) return
    subscribed = active
    if (active) wc.beginFrameSubscription(false, onFrame)
    else wc.endFrameSubscription()
  }
  const arm = (): void => {
    clearTimeout(timer)
    if (presented) return
    timer = setTimeout(() => {
      if (wc.isDestroyed()) return
      wc.setBackgroundThrottling(true)
      capture(false)
      asleep = true
    }, AGENT_TAB_IDLE_MS)
  }
  capture(true)
  arm()
  return {
    wake: () => {
      const woke = asleep
      if (woke) readyAt = Date.now() + AGENT_TAB_WAKE_MS
      if (!wc.isDestroyed()) {
        wc.setBackgroundThrottling(false)
        asleep = false
        capture(!presented)
      }
      arm()
      return woke
    },
    settleDelay: () => Math.max(0, readyAt - Date.now()),
    present: (visible) => {
      if (presented === visible) return
      presented = visible
      if (visible && !wc.isDestroyed()) {
        if (asleep) readyAt = Date.now() + AGENT_TAB_WAKE_MS
        wc.setBackgroundThrottling(false)
        asleep = false
      }
      capture(!visible && !asleep)
      arm()
    },
    subscribed: () => subscribed,
    dispose: () => {
      clearTimeout(timer)
      capture(false)
    },
  }
}

/**
 * BrowserService guest factory for the window hosting `contents`. The tab id
 * must reach createElectronBrowserGuest: it decides whether a background tab
 * must keep rendering for agent tools.
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
 * Agent tabs use native views so the user can interact with the same live page.
 * While hidden, an active frame subscription keeps the capturer count nonzero
 * so Chromium still paints and runs rAF (#432). Disabling background throttling
 * alone does not keep a hidden native view painting. The subscription ends
 * when the page is presented or idle; a presented page renders natively and
 * accepts direct mouse, keyboard, scrolling and element-picker input.
 */
export function createElectronBrowserGuest(
  win: BrowserWindow,
  tabId: string,
  onUpdated: () => void,
): BrowserGuest {
  const agent = tabId.startsWith('agent:')
  const view = new WebContentsView({
    webPreferences: {
      offscreen: false,
      backgroundThrottling: !agent,
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

  let frame: NativeImage | null = null
  let viewport = { width: 800, height: 600 }
  let frameReceived: (() => void) | null = null
  const painter = agent
    ? idlePainter(wc, (image?: NativeImage) => {
        if (image !== undefined && !image.isEmpty()) frame = image
        frameReceived?.()
      })
    : null
  const wake = (): boolean => painter?.wake() ?? false
  // sendInputEvent needs the page focused. Agent input borrows that focus from
  // whoever had it and holds it across calls while a key or button is down, so
  // a held key or a drag split over several tool calls sees no blur. It goes
  // back INPUT_FOCUS_HOLD_MS after the last release, or at once when the user
  // types (that key is not delivered to the page) or the page is hidden or
  // closed. A click elsewhere moves focus natively and ends the loan.
  const heldKeys = new Set<string>()
  let lender: WebContents | null = null
  let sending = false
  let giveBack: ReturnType<typeof setTimeout> | undefined
  const returnFocus = (): void => {
    clearTimeout(giveBack)
    const target = lender
    lender = null
    if (target === null || target.isDestroyed() || wc.isDestroyed() || !wc.isFocused()) return
    target.focus()
  }
  const input = (send: () => void): void => {
    clearTimeout(giveBack)
    if (!wc.isFocused()) {
      if (agent) {
        lender =
          win.contentView.children
            .filter((child): child is WebContentsView => child instanceof WebContentsView)
            .map((child) => child.webContents)
            .find((contents) => contents !== wc && contents.isFocused()) ?? win.webContents
      }
      wc.focus()
    }
    sending = true
    try {
      send()
    } finally {
      sending = false
      if (lender !== null && heldKeys.size === 0 && heldButton === null)
        giveBack = setTimeout(returnFocus, INPUT_FOCUS_HOLD_MS)
    }
  }
  if (agent) {
    wc.on('blur', () => {
      clearTimeout(giveBack)
      lender = null
    })
    // Keys from sendInputEvent pass through here synchronously, inside `sending`.
    wc.on('before-input-event', (event) => {
      if (sending || lender === null) return
      event.preventDefault()
      returnFocus()
    })
  }
  const freshFrame = async (): Promise<void> => {
    if (!agent) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        frameReceived = null
        resolve()
      }, 1000)
      frameReceived = () => {
        clearTimeout(timer)
        frameReceived = null
        resolve()
      }
    })
  }

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
  wc.on('did-start-loading', () => {
    frame = null
    emit()
  })
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
    loadURL: async (url) => {
      wake()
      frame = null
      await wc.loadURL(url)
      // A shown or sleeping page has no subscription, so no frame would come.
      if (painter?.subscribed() === true) await freshFrame()
    },
    goBack: () => {
      wake()
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    },
    goForward: () => {
      wake()
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    },
    reload: () => {
      wake()
      wc.reload()
    },
    canGoBack: () => wc.navigationHistory.canGoBack(),
    canGoForward: () => wc.navigationHistory.canGoForward(),
    getURL: () => wc.getURL(),
    getTitle: () => wc.getTitle(),
    isLoading: () => wc.isLoading(),
    executeJavaScript: (code) => {
      wake()
      return wc.executeJavaScript(code, true)
    },
    consoleEntries: () => consoleBuffer.entries(),
    capturePage: async (rect, format = 'png', size) => {
      // Reading the viewport can wake a tab before its screenshot request. Keep
      // the settling deadline across actions so the first capture is fresh.
      wake()
      const delay = painter?.settleDelay() ?? 0
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      for (let attempt = 1; ; attempt++) {
        try {
          const captured = encodeCapture(await wc.capturePage(rect), format, size)
          if (captured !== null) return captured
        } catch {
          // Hidden native surfaces can have no copyable frame during a handoff.
        }
        if (wc.isDestroyed()) return null
        // Subscription images contain device pixels. Element rectangles are CSS
        // pixels, so only a whole-viewport capture may use this fallback.
        if (rect === undefined && frame !== null) return encodeCapture(frame, format, size)
        if (attempt >= CAPTURE_ATTEMPTS) return null
        await new Promise((resolve) => setTimeout(resolve, CAPTURE_RETRY_MS))
      }
    },
    sendKey: (key, phase, modifiers) => {
      wake()
      input(() => {
        wc.sendInputEvent({
          type: phase === 'down' ? 'keyDown' : 'keyUp',
          keyCode: acceleratorKey(key),
          modifiers,
        })
        if (phase === 'down') heldKeys.add(key)
        else heldKeys.delete(key)
      })
    },
    sendMouse: (phase, x, y, button, modifiers) => {
      wake()
      input(() => {
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
      })
    },
    setBounds: (bounds) => {
      if (viewport.width !== bounds.width || viewport.height !== bounds.height) {
        frame = null
        viewport = { width: bounds.width, height: bounds.height }
      }
      view.setBounds(bounds)
    },
    setVisible: (visible) => {
      if (win.isDestroyed()) return
      if (visible) {
        // Its subscription frame predates the page the user is about to change.
        frame = null
        win.contentView.addChildView(view)
      }
      view.setVisible(visible)
      if (agent && !visible) {
        if (lender !== null) returnFocus()
        else if (wc.isFocused()) win.webContents.focus()
      }
      painter?.present(visible)
    },
    destroy: () => {
      returnFocus()
      painter?.dispose()
      frame = null
      if (!win.isDestroyed()) win.contentView.removeChildView(view)
      if (!wc.isDestroyed()) wc.close()
    },
  }
}
