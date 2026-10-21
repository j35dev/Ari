import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  MousePointer2,
  RotateCw,
  X,
} from 'lucide-react'
import { IconButton } from '@ari/ui/icon-button'
import { Input } from '@ari/ui/input'
import type { BrowserTabState } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { addBrowserPick, fileFromPngBase64 } from './browser-picks'
import { trackBounds, type Bounds } from './bounds-sync'
import { useCovered } from './use-covered'
import { watchOverlays } from './overlay-cover'

const TAB_ID = 'inspector'
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
  id: TAB_ID,
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
 */
export function BrowserPanel({ onClose }: { onClose?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<BrowserTabState>(EMPTY)
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
    void rpc
      .invoke('browser.layout', { id: TAB_ID, visible, ...bounds })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    void rpc
      .invoke('browser.open', { id: TAB_ID })
      .then((next) => {
        setTab(next)
        if (next.url !== 'about:blank') setDraft(next.url)
      })
      .catch(() => undefined)
    const unsub = rpc.subscribe('browser.updated', { id: TAB_ID }, (payload) => {
      const next = payload as BrowserTabState
      if (next.id !== TAB_ID) return
      setTab(next)
      if (!next.loading) setDraft(next.url === 'about:blank' ? '' : next.url)
    })
    return () => {
      unsub()
      avoidForToasts(null)
      void rpc.invoke('browser.cancelPick', { id: TAB_ID })
      void rpc.invoke('browser.layout', {
        id: TAB_ID,
        visible: false,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      })
    }
  }, [])

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
        .invoke('browser.capture', { id: TAB_ID })
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
      .invoke('browser.navigate', { id: TAB_ID, url: draft })
      .then((result) => {
        if (!result.ok) setTab((prev) => ({ ...prev, error: result.error }))
      })
      .catch(() => undefined)
  }

  const go = (action: 'back' | 'forward' | 'reload'): void => {
    void rpc.invoke('browser.go', { id: TAB_ID, action }).catch(() => undefined)
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
      .invoke('browser.pick', { id: TAB_ID })
      .then((result) => {
        if (result.ok) {
          const image =
            result.pngBase64 !== null
              ? fileFromPngBase64(result.pngBase64, `${result.element.tag}.png`)
              : null
          addBrowserPick(result.element, image)
        }
      })
      .catch(() => undefined)
      .finally(() => setPicking(false))
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <Globe size={13} className="ml-1 shrink-0 text-fg-subtle" aria-hidden />
        <span className="truncate text-xs font-medium text-fg">Browser</span>
        <div className="flex-1" />
        {onClose !== undefined ? (
          <IconButton
            icon={<X size={13} />}
            aria-label="Close browser panel"
            size="sm"
            variant="ghost"
            onClick={onClose}
          />
        ) : null}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <IconButton
          icon={<ArrowLeft size={13} />}
          aria-label="Back"
          size="sm"
          variant="ghost"
          disabled={!tab.canGoBack}
          onClick={() => go('back')}
        />
        <IconButton
          icon={<ArrowRight size={13} />}
          aria-label="Forward"
          size="sm"
          variant="ghost"
          disabled={!tab.canGoForward}
          onClick={() => go('forward')}
        />
        <IconButton
          icon={<RotateCw size={13} className={tab.loading ? 'animate-spin' : undefined} />}
          aria-label="Reload"
          size="sm"
          variant="ghost"
          onClick={() => go('reload')}
        />
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Enter a URL"
            aria-label="Address"
            className="h-7 text-2xs"
            invalid={tab.error !== null}
          />
        </form>
        <IconButton
          icon={<MousePointer2 size={13} />}
          aria-label="Pick element for agent"
          title="Pick an element to mention to the agent"
          size="sm"
          variant="ghost"
          disabled={blank || picking}
          onClick={pickElement}
        />
        <IconButton
          icon={<ExternalLink size={13} />}
          aria-label="Open in system browser"
          size="sm"
          variant="ghost"
          disabled={blank}
          onClick={openExternal}
        />
      </div>
      {tab.error !== null ? (
        <p className="shrink-0 px-3 py-1.5 text-2xs text-danger">{tab.error}</p>
      ) : null}
      <div ref={hostRef} className="relative min-h-0 flex-1">
        {blank ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
            <p className="text-xs text-fg-subtle">In-app browser</p>
            <p className="max-w-56 text-2xs text-fg-subtle/70">
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
