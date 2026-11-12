import { useEffect, useRef, useState } from 'react'
import {
  isWallpaperSetting,
  wallpapers,
  type WallpaperId,
  type WallpaperSetting,
} from '@ari/ui/wallpapers'
import { paintDitherScene } from './dither'

/** Which view the scene sits behind: a new session, or Aria's empty chat. */
export type SceneKind = 'session' | 'aria'

/**
 * The art shown when no wallpaper is chosen. Aria has her own, so her page is
 * recognisable before anything is read.
 */
const DEFAULT_ART: Record<SceneKind, Record<'dark' | 'light', WallpaperId>> = {
  session: { dark: 'anime-city', light: 'stillwater' },
  aria: { dark: 'moon-landscape-2', light: 'moon-landscape' },
}

/** The chosen wallpaper wins; otherwise the default for the view and scheme. */
export function sceneArt(
  kind: SceneKind,
  wallpaper: WallpaperSetting,
  scheme: 'dark' | 'light',
): WallpaperId {
  return wallpaper === 'none' ? DEFAULT_ART[kind][scheme] : wallpaper
}

const REPAINT_DELAY_MS = 60
const THEME_ATTRIBUTES = ['data-ari-theme', 'data-ari-scheme', 'data-ari-wallpaper']

interface Look {
  /** Changes whenever the palette does, so the art re-sinks into the new page. */
  theme: string
  scheme: 'dark' | 'light'
  wallpaper: WallpaperSetting
}

/**
 * The look as the ThemeProvider reflected it onto `<html>`. Read from the
 * document rather than from context so the scene repaints after the new
 * palette has actually landed, and works wherever a view is mounted.
 */
function readLook(): Look {
  const data = document.documentElement.dataset
  const wallpaper = data['ariWallpaper']
  return {
    theme: data['ariTheme'] ?? '',
    scheme: data['ariScheme'] === 'light' ? 'light' : 'dark',
    wallpaper: isWallpaperSetting(wallpaper) ? wallpaper : 'none',
  }
}

/**
 * Wallpaper art behind an empty stage: sharp at the top, dissolved into the
 * page with an ordered dither. Purely decorative; it fills its positioned
 * parent and never takes pointer events.
 */
export function DitherScene({
  kind = 'session',
  className,
}: {
  kind?: SceneKind
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [look, setLook] = useState(readLook)
  const [ready, setReady] = useState(false)
  const src = wallpapers.find((w) => w.id === sceneArt(kind, look.wallpaper, look.scheme))?.src

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = readLook()
      setLook((current) =>
        current.theme === next.theme &&
        current.scheme === next.scheme &&
        current.wallpaper === next.wallpaper
          ? current
          : next,
      )
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: THEME_ATTRIBUTES,
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (host === null || canvas === null || src === undefined) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const image = new Image()
    image.decoding = 'async'

    const paint = () => {
      if (disposed || !image.complete) return
      const page = getComputedStyle(document.documentElement).getPropertyValue('--ari-bg').trim()
      if (page !== '' && paintDitherScene(canvas, image, page)) setReady(true)
    }
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(paint, REPAINT_DELAY_MS)
    }

    image.onload = schedule
    image.src = src
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(host)
    return () => {
      disposed = true
      clearTimeout(timer)
      observer?.disconnect()
      image.onload = null
    }
  }, [src, look.theme])

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-ready={ready ? '' : undefined}
      className={className === undefined ? 'ari-scene' : `ari-scene ${className}`}
    >
      <canvas ref={canvasRef} />
    </div>
  )
}
