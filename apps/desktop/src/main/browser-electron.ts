import { BrowserWindow, WebContentsView, type NativeImage, type WebContents } from 'electron'
import { encodeCapture } from './browser-capture'
import { ConsoleBuffer } from './browser-console'
import type {
  BrowserBounds,
  BrowserGuest,
  BrowserGuestFactory,
  PointerButton,
} from './browser-service'
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
 * A hidden native view's first capture can be empty on Windows or reject with
 * UnknownVizError on Linux while Chromium makes the surface copyable. Allow
 * one second for that handoff, without accepting an empty screenshot.
 */
export const CAPTURE_RETRY_MS = 50
export const CAPTURE_ATTEMPTS = 21
/** A full-size capture attempt that has not answered in this long is abandoned. */
const FULL_SIZE_CAPTURE_MS = 250
/**
 * Agent input borrows keyboard focus for the page and gives it back this long
 * after its last event, unless a key or mouse button is still held down.
 */
export const INPUT_FOCUS_HOLD_MS = 500

/**
 * The narrowest page an agent tab lays out at, and its size before any panel
 * has placed it. An agent reads and screenshots a page the way a desktop
 * visitor sees it, however narrow the docked panel is: a panel narrower than
 * this shows the page scaled down to fit rather than reflowed to a phone
 * layout.
 */
export const AGENT_DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const

/** The tallest viewport a fitted agent page gets; a desktop window, not a scroll. */
export const AGENT_MAX_VIEWPORT_HEIGHT = 1000

/**
 * The CSS viewport an agent page lays out at inside `panel`, and the scale
 * that fits it there: at least the desktop width, and as tall as the panel at
 * that scale up to a desktop window's height (a narrow panel's full height
 * would be a portrait page no desktop visitor sees). With no panel yet, the
 * plain desktop size.
 */
export function agentLayout(panel: BrowserBounds | null): {
  width: number
  height: number
  scale: number
} {
  if (panel === null || panel.width <= 0 || panel.height <= 0)
    return { ...AGENT_DESKTOP_VIEWPORT, scale: 1 }
  const width = Math.max(AGENT_DESKTOP_VIEWPORT.width, panel.width)
  const scale = panel.width / width
  const height = Math.min(Math.round(panel.height / scale), AGENT_MAX_VIEWPORT_HEIGHT)
  return { width, height, scale }
}

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
  view.setBounds(
    agent ? { x: 0, y: 0, ...AGENT_DESKTOP_VIEWPORT } : { x: 0, y: 0, width: 800, height: 600 },
  )
  view.setVisible(false)
  const wc = view.webContents
  let presented = false
  let heldButton: PointerButton | null = null
  wc.setUserAgent(wc.getUserAgent().replace(/\sElectron\/\S+/g, ''))

  let frame: NativeImage | null = null
  let viewport: { width: number; height: number } = agent
    ? { ...AGENT_DESKTOP_VIEWPORT }
    : { width: 800, height: 600 }
  // Where the panel placed this page, and how an agent page is fitted there.
  let placed: BrowserBounds | null = null
  /** Widget px per page CSS px; below 1 while a desktop page is fitted into a narrow panel. */
  let layoutScale = 1
  let emulated = ''
  const resize = (bounds: BrowserBounds): void => {
    if (viewport.width !== bounds.width || viewport.height !== bounds.height) {
      frame = null
      viewport = { width: bounds.width, height: bounds.height }
    }
    view.setBounds(bounds)
  }
  const emulate = (layout: { width: number; height: number; scale: number } | null): void => {
    const key = layout === null ? '' : `${layout.width}x${layout.height}@${layout.scale}`
    if (key === emulated || wc.isDestroyed()) return
    emulated = key
    layoutScale = layout?.scale ?? 1
    if (layout === null) {
      wc.disableDeviceEmulation()
      return
    }
    const size = { width: layout.width, height: layout.height }
    wc.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: size,
      viewPosition: { x: 0, y: 0 },
      viewSize: size,
      deviceScaleFactor: 0,
      scale: layout.scale,
    })
  }
  /**
   * Sizes the view for where it is. The inspector tab simply fills its panel.
   * An agent page lays out at desktop width: shown in a narrower panel it is
   * emulated at that width and scaled to fit (Chromium maps real input through
   * the same transform); hidden, the view itself takes the desktop size, so
   * captures need no scaling at all.
   */
  const applyLayout = (): void => {
    if (!agent) {
      if (placed !== null) resize(placed)
      return
    }
    const layout = agentLayout(placed)
    if (presented && placed !== null && layout.scale < 1) {
      // The view covers only the scaled page; the panel's own background
      // shows below it when the panel is taller.
      resize({
        ...placed,
        height: Math.min(placed.height, Math.ceil(layout.height * layout.scale)),
      })
      emulate(layout)
      return
    }
    emulate(null)
    const origin = placed ?? { x: 0, y: 0 }
    resize(
      presented && placed !== null
        ? placed
        : { x: origin.x, y: origin.y, width: layout.width, height: layout.height },
    )
  }
  let frameReceived: (() => void) | null = null
  const painter = agent
    ? idlePainter(wc, (image?: NativeImage) => {
        if (image === undefined || image.isEmpty()) return
        frame = image
        frameReceived?.()
      })
    : null
  // A placed panel can still be hidden by the tray, minimization, or another
  // app. Keep its capturer alive until the host can paint it natively again.
  const updatePresentation = (): void => {
    if (win.isDestroyed()) return
    painter?.present(presented && win.isVisible() && !win.isMinimized() && win.isFocused())
  }
  if (agent) {
    win.on('show', updatePresentation)
    win.on('hide', updatePresentation)
    win.on('minimize', updatePresentation)
    win.on('restore', updatePresentation)
    win.on('focus', updatePresentation)
    win.on('blur', updatePresentation)
  }
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

  const captureFullSize = async (
    format: 'png' | 'jpeg',
    size: { width: number; height: number },
  ): Promise<Buffer | null> => {
    const at = placed
    // Only a page on screen is resized for this. With Ari hidden in the tray
    // or minimized, the resized surface is never copied; the caller then
    // takes the fitted capture instead.
    if (at === null || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return null
    const layout = agentLayout(at)
    try {
      // Slid left until one pixel column remains inside the panel. A hidden
      // view keeps its old surface and one parked wholly outside the window
      // paints no new frames, so either would hand back the scaled page; this
      // one renders at the real size while the panel's still of the page
      // stands in for it.
      emulate(null)
      resize({
        x: at.x - layout.width + 1,
        y: at.y,
        width: layout.width,
        height: layout.height,
      })
      for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, CAPTURE_RETRY_MS))
        if (wc.isDestroyed()) return null
        try {
          // The first copies can still be the scaled surface from before the
          // resize; only a full-width one is the page at its real size.
          const image = await Promise.race([
            wc.capturePage(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), FULL_SIZE_CAPTURE_MS)),
          ])
          if (image === null || image.getSize().width < layout.width) continue
          const captured = encodeCapture(image, format, size)
          if (captured !== null) return captured
        } catch {
          // The resized surface may not be copyable for a frame or two.
        }
      }
      return null
    } finally {
      if (!wc.isDestroyed() && !win.isDestroyed()) applyLayout()
    }
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
      // A fitted page is drawn scaled; its CSS rect is that much smaller on screen.
      const shown =
        rect === undefined || layoutScale === 1
          ? rect
          : {
              x: Math.round(rect.x * layoutScale),
              y: Math.round(rect.y * layoutScale),
              width: Math.max(1, Math.round(rect.width * layoutScale)),
              height: Math.max(1, Math.round(rect.height * layoutScale)),
            }
      // An agent's screenshot of a page fitted into a narrow panel would come
      // back at the panel's resolution. Capture it at full size instead, with
      // the view briefly parked outside the window at the page's real size.
      if (size !== undefined && rect === undefined && layoutScale < 1 && placed !== null) {
        const full = await captureFullSize(format, size)
        if (full !== null) return full
      }
      for (let attempt = 1; ; attempt++) {
        try {
          const captured = encodeCapture(await wc.capturePage(shown), format, size)
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
    sendMouse: (phase, cssX, cssY, button, modifiers) => {
      wake()
      // Agents point in page CSS px; a fitted page is drawn `layoutScale` times
      // smaller, and Chromium maps widget input back through that scale.
      const x = Math.round(cssX * layoutScale)
      const y = Math.round(cssY * layoutScale)
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
      placed = bounds
      applyLayout()
    },
    setVisible: (visible) => {
      if (win.isDestroyed()) return
      presented = visible
      // Sized for where it is going before it shows, and back to the desktop
      // size once it is hidden.
      applyLayout()
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
      updatePresentation()
    },
    destroy: () => {
      returnFocus()
      if (agent) {
        win.removeListener('show', updatePresentation)
        win.removeListener('hide', updatePresentation)
        win.removeListener('minimize', updatePresentation)
        win.removeListener('restore', updatePresentation)
        win.removeListener('focus', updatePresentation)
        win.removeListener('blur', updatePresentation)
      }
      painter?.dispose()
      frame = null
      if (!win.isDestroyed()) win.contentView.removeChildView(view)
      if (!wc.isDestroyed()) wc.close()
    },
  }
}
