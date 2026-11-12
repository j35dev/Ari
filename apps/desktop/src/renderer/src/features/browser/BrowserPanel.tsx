import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, MousePointer2, RotateCw } from 'lucide-react'
import type { BrowserTabState } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { cx, iconButton, iconButtonActive } from '../../lib/recipes'
import { addBrowserPick, fileFromPngBase64 } from './browser-picks'
import { trackBounds, type Bounds } from './bounds-sync'
import { useCovered } from './use-covered'
import { watchOverlays } from './overlay-cover'

/** The page shown when no session is open: the app's own shared tab. */
const SHARED_TAB = 'inspector'

/**
 * A session's page is the one its agent drives through the browser tools, so
 * the panel shows what the agent is doing and the user can steer the same page.
 */
export function browserTabFor(sessionId: string | undefined): string {
  return sessionId === undefined ? SHARED_TAB : `agent:${sessionId}`
}
const STILL_AFTER_LOAD_MS = 300
const STILL_REFRESH_MS = 2000

/** Resolves once `url` is decoded, so swapping it in never shows a half-drawn frame. */
async function decoded(url: string): Promise<void> {
  const image = new Image()
  image.src = url
  try {
    await image.decode()
  } catch {
    // Undecodable here means the <img> shows nothing either; it is replaced on the next refresh.
  }
}

/**
 * The guest paints over everything, toasts included, so while it shows the
 * toast stack keeps to the left of it rather than freezing it behind a still:
 * update toasts are sticky and would otherwise leave the page frozen.
 */
function avoidForToasts(bounds: Bounds | null): void {
  const root = document.documentElement.style
  if (bounds === null) root.removeProperty('--ari-native-inset-right')
  else root.setProperty('--ari-native-inset-right', `${window.innerWidth - bounds.x}px`)
}

const EMPTY: BrowserTabState = {
  id: SHARED_TAB,
  url: 'about:blank',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  error: null,
}

/**
 * Inspector-rail browser: address chrome in the renderer, Chromium guest in
 * the main process. The host div is only a bounds target — the page itself
 * is a WebContentsView overlaid by main, above everything the renderer draws.
 * So while app UI overlaps the host, the guest gives way to a still of itself:
 * registered overlays hide it before they first paint, anything else once the
 * hit-test sweep finds it.
 *
 * The panel starts at its address row. Its name and the close button live in
 * the docked panel's tab row, drawn by the host, so `onClose` is accepted for
 * the host's sake and never drawn here.
 */
export function BrowserPanel({ sessionId }: { onClose?: () => void; sessionId?: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const tabId = browserTabFor(sessionId)
  const [tab, setTab] = useState<BrowserTabState>(EMPTY)
  /** Whether the page on screen is still blank, read when the panel leaves it. */
  const blankRef = useRef(true)
  const [draft, setDraft] = useState('')
  const [picking, setPicking] = useState(false)
  const [still, setStill] = useState<string | null>(null)

  const boundsRef = useRef<Bounds | null>(null)
  // Why the guest may not show, kept outside React so a cover hides it in the
  // same task that detects it rather than after a render and a passive effect.
  const gateRef = useRef({ showGuest: false, overlaid: false, covered: false })
  const visibleRef = useRef(false)
  const sentRef = useRef('')

  const pushLayout = useCallback(() => {
    const bounds = boundsRef.current
    if (bounds === null) return
    const { showGuest, overlaid, covered } = gateRef.current
    // A host with no box sits under `display: none` (a hidden space, Settings
    // open over the workspace); a guest left showing there would float on top.
    const placed = bounds.width > 0 && bounds.height > 0
    const visible = showGuest && placed && !overlaid && !covered
    const key = `${visible} ${showGuest} ${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`
    if (key === sentRef.current) return
    sentRef.current = key
    visibleRef.current = visible
    // Keyed to the page being up at all, so a menu opening over it does not shuffle the toasts.
    avoidForToasts(showGuest && placed ? bounds : null)
    void rpc.invoke('browser.layout', { id: tabId, visible, ...bounds }).catch(() => undefined)
  }, [tabId])

  useEffect(() => {
    // Another session's page: start from nothing and place it afresh.
    let live = true
    blankRef.current = true
    sentRef.current = ''
    setTab({ ...EMPTY, id: tabId })
    setDraft('')
    setStill(null)
    setPicking(false)
    const show = (next: BrowserTabState): void => {
      blankRef.current = next.url === 'about:blank' && !next.loading
      setTab(next)
    }
    void rpc
      .invoke('browser.open', { id: tabId })
      .then((next) => {
        if (!live) return
        show(next)
        if (next.url !== 'about:blank') setDraft(next.url)
      })
      .catch(() => undefined)
    const unsub = rpc.subscribe('browser.updated', { id: tabId }, (payload) => {
      const next = payload as BrowserTabState
      if (next.id !== tabId) return
      show(next)
      if (!next.loading) setDraft(next.url === 'about:blank' ? '' : next.url)
    })
    return () => {
      live = false
      unsub()
      avoidForToasts(null)
      void rpc.invoke('browser.cancelPick', { id: tabId })
      void rpc.invoke('browser.layout', {
        id: tabId,
        visible: false,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      })
      // A session page nobody loaded anything into is not worth keeping; the
      // agent's tools open it again the moment they need it.
      if (tabId !== SHARED_TAB && blankRef.current)
        void rpc.invoke('browser.close', { id: tabId }).catch(() => undefined)
    }
  }, [tabId])

  const showGuest = tab.url !== 'about:blank' || tab.loading
  // Fallback for app UI that does not register as an overlay: hit-testing
  // only notices it once painted, so it is spaced out and arrives late.
  const covered = useCovered(hostRef, showGuest)

  useEffect(() => {
    gateRef.current.showGuest = showGuest
    gateRef.current.covered = covered
    pushLayout()
  }, [pushLayout, showGuest, covered])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const stopBounds = trackBounds(host, (bounds) => {
      boundsRef.current = bounds
      pushLayout()
    })
    const stopOverlays = watchOverlays(host, (overlaid) => {
      gateRef.current.overlaid = overlaid
      pushLayout()
    })
    return () => {
      stopBounds()
      stopOverlays()
    }
  }, [pushLayout])

  // The guest can only be captured while it shows, so the stand-in for any
  // cover is the latest still taken before it: one after each load, then a
  // cheap JPEG every few seconds while the page is on screen.
  useEffect(() => {
    if (!showGuest || tab.loading) return
    let live = true
    const refresh = (): void => {
      if (!visibleRef.current || document.visibilityState !== 'visible') return
      void rpc
        .invoke('browser.capture', { id: tabId })
        .then(async ({ dataUrl }) => {
          if (dataUrl === null) return
          await decoded(dataUrl)
          if (live) setStill(dataUrl)
        })
        .catch(() => undefined)
    }
    const settled = window.setTimeout(refresh, STILL_AFTER_LOAD_MS)
    const timer = window.setInterval(refresh, STILL_REFRESH_MS)
    return () => {
      live = false
      window.clearTimeout(settled)
      window.clearInterval(timer)
    }
  }, [showGuest, tab.loading, tab.url])

  const submit = (): void => {
    void rpc
      .invoke('browser.navigate', { id: tabId, url: draft })
      .then((result) => {
        if (!result.ok) setTab((prev) => ({ ...prev, error: result.error }))
      })
      .catch(() => undefined)
  }

  const go = (action: 'back' | 'forward' | 'reload'): void => {
    void rpc.invoke('browser.go', { id: tabId, action }).catch(() => undefined)
  }

  const blank = !showGuest

  const openExternal = (): void => {
    if (tab.url === 'about:blank') return
    void rpc.invoke('shell.openUrl', { url: tab.url }).catch(() => undefined)
  }

  const pickElement = (): void => {
    if (blank || picking) return
    setPicking(true)
    void rpc
      .invoke('browser.pick', { id: tabId })
      .then((result) => {
        if (result.ok) {
          const image =
            result.pngBase64 !== null
              ? fileFromPngBase64(result.pngBase64, `${result.element.tag}.png`)
              : null
          addBrowserPick(result.element, image, sessionId)
        }
      })
      .catch(() => undefined)
      .finally(() => setPicking(false))
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border px-2">
        <button
          type="button"
          aria-label="Back"
          disabled={!tab.canGoBack}
          onClick={() => go('back')}
          className={iconButton}
        >
          <ArrowLeft size={14} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Forward"
          disabled={!tab.canGoForward}
          onClick={() => go('forward')}
          className={iconButton}
        >
          <ArrowRight size={14} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Reload"
          onClick={() => go('reload')}
          className={iconButton}
        >
          <RotateCw size={14} aria-hidden className={tab.loading ? 'animate-spin' : undefined} />
        </button>
        <form
          className="mx-1 min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Enter a URL"
            aria-label="Address"
            aria-invalid={tab.error !== null || undefined}
            className="h-7 w-full min-w-0 rounded-md bg-fg/6 px-2.5 text-[13px] text-fg outline-none transition-shadow placeholder:text-fg-subtle focus-visible:ring-2 focus-visible:ring-accent-ring aria-invalid:ring-1 aria-invalid:ring-danger"
          />
        </form>
        <button
          type="button"
          aria-label="Pick element for agent"
          title="Pick an element to mention to the agent"
          disabled={blank || picking}
          onClick={pickElement}
          className={cx(iconButton, picking && iconButtonActive)}
        >
          <MousePointer2 size={14} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Open in system browser"
          disabled={blank}
          onClick={openExternal}
          className={iconButton}
        >
          <ExternalLink size={14} aria-hidden />
        </button>
      </div>
      {tab.error !== null ? (
        <p className="shrink-0 px-4 py-1.5 text-xs text-danger">{tab.error}</p>
      ) : null}
      <div ref={hostRef} className="relative min-h-0 flex-1">
        {blank ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
            <p className="text-[13px] text-fg-muted">In-app browser</p>
            <p className="max-w-56 text-xs text-fg-subtle">
              Type a URL, then pick an element to mention it to the agent.
            </p>
          </div>
        ) : null}
        {!blank && still !== null ? (
          // Always under the guest, so hiding the guest reveals it with no wait.
          <img
            src={still}
            alt=""
            decoding="sync"
            draggable={false}
            className="absolute inset-0 h-full w-full"
          />
        ) : null}
      </div>
    </div>
  )
}
