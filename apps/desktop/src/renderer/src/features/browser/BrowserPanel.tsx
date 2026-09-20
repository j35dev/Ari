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

const TAB_ID = 'inspector'

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
 * is a WebContentsView overlaid by main.
 */
export function BrowserPanel({ onClose }: { onClose?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<BrowserTabState>(EMPTY)
  const [draft, setDraft] = useState('')
  const [picking, setPicking] = useState(false)

  const syncLayout = useCallback((visible: boolean) => {
    const host = hostRef.current
    if (host === null) return
    const rect = host.getBoundingClientRect()
    void rpc
      .invoke('browser.layout', {
        id: TAB_ID,
        visible,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
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

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const observer = new ResizeObserver(() => syncLayout(showGuest))
    observer.observe(host)
    syncLayout(showGuest)
    return () => observer.disconnect()
  }, [syncLayout, showGuest])

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
      </div>
    </div>
  )
}
