import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { defaultThemeId, isThemeId, systemTheme, themes } from './themes'
import type { Theme, ThemeId } from './themes'
import { isWallpaperSetting, wallpapers } from './wallpapers'
import type { WallpaperSetting } from './wallpapers'

/**
 * Theme engine. Owns the active theme, the `system` follow mode, and the
 * wallpaper selection, and reflects them onto `<html>` as `data-ari-theme`,
 * `data-ari-scheme`, and `data-ari-wallpaper` so no component needs to know
 * which theme is active.
 *
 * Persistence is injected (`persistence` prop) because @ari/ui must not depend
 * on the desktop RPC client; the renderer passes an engine-settings adapter.
 * localStorage is kept as a synchronous pre-hydration cache so the first paint
 * already carries the right palette instead of flashing the default.
 */

/** User selection: an explicit theme or `system` (follow the OS scheme). */
export type ThemeMode = 'system' | ThemeId

export interface ThemePreferences {
  mode: ThemeMode
  /** Bundled background scene shown behind the themed UI, or 'none'. */
  wallpaper: WallpaperSetting
}

/** Adapter onto durable storage (the engine settings store in the app). */
export interface ThemePersistence {
  load: () => Promise<Partial<ThemePreferences & { themeId: ThemeId }> | null>
  save: (prefs: ThemePreferences & { themeId: ThemeId }) => Promise<void>
}

export interface ThemeContextValue {
  /** Id of the theme actually painted (resolved through `system`). */
  themeId: ThemeId
  /** Full palette of the painted theme. */
  theme: Theme
  /** Pins an explicit theme. */
  setTheme: (id: ThemeId) => void
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  resolvedScheme: 'light' | 'dark'
  /** Active wallpaper selection ('none' = plain theme background). */
  wallpaper: WallpaperSetting
  setWallpaper: (wallpaper: WallpaperSetting) => void
}

const STORAGE_KEY = 'ari.theme'

const ThemeContext = createContext<ThemeContextValue | null>(null)

function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches
  } catch {
    return false
  }
}

function readCache(): ThemePreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const { mode, wallpaper } = parsed as {
          mode?: unknown
          wallpaper?: unknown
        }
        return {
          mode: mode === 'system' || isThemeId(mode) ? mode : 'system',
          wallpaper: isWallpaperSetting(wallpaper) ? wallpaper : 'none',
        }
      }
    }
  } catch {
    // storage unavailable or corrupt — defaults apply
  }
  return { mode: 'system', wallpaper: 'none' }
}

function writeCache(prefs: ThemePreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // non-fatal: preferences simply won't survive a reload
  }
}

/**
 * Reflects the wallpaper selection onto `<html>` for wallpaper.css: the
 * attribute gates every wallpaper rule (absent for 'none', so the plain theme
 * is restored exactly), and `--ari-wallpaper-image` carries the scene's URL.
 *
 * The URL comes from the registry's bundled import rather than a `url()`
 * literal in the CSS: that file is `@import`ed, so its relative asset paths
 * survive the production build unrebased and unhashed, which broke the
 * packaged app while working in dev (see wallpaper.css).
 */
function applyWallpaperAttr(root: HTMLElement, wallpaper: WallpaperSetting): void {
  if (wallpaper === 'none') {
    delete root.dataset['ariWallpaper']
    root.style.removeProperty('--ari-wallpaper-image')
    return
  }
  root.dataset['ariWallpaper'] = wallpaper
  const src = wallpapers.find((w) => w.id === wallpaper)?.src
  if (src === undefined) root.style.removeProperty('--ari-wallpaper-image')
  else root.style.setProperty('--ari-wallpaper-image', `url("${src}")`)
}

/**
 * Paints the cached theme onto `<html>` before React mounts, so a light-theme
 * user never sees a frame of the default dark palette. Call once from the
 * renderer entry point; the provider re-applies (and corrects) after hydration.
 * Deliberately not an inline `<script>` in index.html: the packaged CSP is
 * `default-src 'self'` and inline script would require loosening it.
 */
export function applyCachedTheme(): void {
  const prefs = readCache()
  const theme =
    prefs.mode === 'system'
      ? systemTheme(matches('(prefers-color-scheme: dark)'))
      : themes[prefs.mode]
  const root = document.documentElement
  root.dataset['ariTheme'] = theme.id
  root.dataset['ariScheme'] = theme.scheme
  delete root.dataset['ariGlass']
  applyWallpaperAttr(root, prefs.wallpaper)
}

/** Where the last click landed, so a theme change can open outward from it. */
let lastClick: { x: number; y: number; at: number } | null = null

function trackClick(event: MouseEvent): void {
  // A keyboard-activated click reports (0, 0); use the control's own centre.
  if (event.detail === 0 && event.target instanceof Element) {
    const box = event.target.getBoundingClientRect()
    lastClick = { x: box.left + box.width / 2, y: box.top + box.height / 2, at: performance.now() }
    return
  }
  lastClick = { x: event.clientX, y: event.clientY, at: performance.now() }
}

/** How long after a click a theme change still counts as its consequence. */
const REVEAL_WINDOW_MS = 800

/**
 * Applies a theme change inside a view transition where the engine has one,
 * so the palette is revealed outward from the click that chose it rather than
 * every colour snapping at once (see motion.css). A change nobody clicked for
 * — the OS switching scheme — cross-fades instead. Falls back to a plain
 * synchronous apply without the API or under reduced motion.
 */
function revealTheme(root: HTMLElement, apply: () => void): void {
  const start = (
    document as { startViewTransition?: (update: () => void) => { finished: Promise<void> } }
  ).startViewTransition
  const still = 'ariReduceMotion' in root.dataset || matches('(prefers-reduced-motion: reduce)')
  if (typeof start !== 'function' || still) {
    apply()
    return
  }
  const click = lastClick
  if (click !== null && performance.now() - click.at < REVEAL_WINDOW_MS) {
    root.style.setProperty('--ari-reveal-x', `${click.x}px`)
    root.style.setProperty('--ari-reveal-y', `${click.y}px`)
    root.dataset['ariThemeReveal'] = ''
  }
  const settle = (): void => {
    delete root.dataset['ariThemeReveal']
    root.style.removeProperty('--ari-reveal-x')
    root.style.removeProperty('--ari-reveal-y')
  }
  start.call(document, apply).finished.then(settle, settle)
}

/** Subscribes to a media query, returning its current match state. */
function useMediaQuery(query: string): boolean {
  const [matched, setMatched] = useState(() => matches(query))
  useEffect(() => {
    let list: MediaQueryList
    try {
      list = window.matchMedia(query)
    } catch {
      return
    }
    const onChange = (event: MediaQueryListEvent): void => setMatched(event.matches)
    setMatched(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matched
}

export function ThemeProvider({
  children,
  persistence,
}: {
  children: ReactNode
  persistence?: ThemePersistence
}) {
  const [prefs, setPrefs] = useState<ThemePreferences>(readCache)
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')
  // Gates the save effect: writing the localStorage cache back before the
  // durable copy has been read would clobber it with a stale value.
  const [hydrated, setHydrated] = useState(!persistence)

  // Adopt the durable copy once; the cache only exists to avoid a flash.
  useEffect(() => {
    if (!persistence) return
    let cancelled = false
    persistence.load().then(
      (stored) => {
        if (cancelled) return
        if (stored) {
          setPrefs((current) => ({
            mode: stored.mode === 'system' || isThemeId(stored.mode) ? stored.mode : current.mode,
            wallpaper: isWallpaperSetting(stored.wallpaper) ? stored.wallpaper : current.wallpaper,
          }))
        }
        setHydrated(true)
      },
      () => {
        // Unreadable durable store: keep the cached preferences and allow
        // later user changes to persist rather than freezing the UI.
        if (!cancelled) setHydrated(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [persistence])

  const theme =
    prefs.mode === 'system'
      ? systemTheme(prefersDark)
      : (themes[prefs.mode] ?? themes[defaultThemeId])

  useEffect(() => {
    document.addEventListener('click', trackClick, true)
    return () => document.removeEventListener('click', trackClick, true)
  }, [])

  const painted = useRef(false)
  useEffect(() => {
    const root = document.documentElement
    const apply = (): void => {
      root.dataset['ariTheme'] = theme.id
      root.dataset['ariScheme'] = theme.scheme
      delete root.dataset['ariGlass']
      applyWallpaperAttr(root, prefs.wallpaper)
    }
    // The first run only confirms what applyCachedTheme already painted, and a
    // wallpaper change is not a theme change: neither is worth a transition.
    if (!painted.current || root.dataset['ariTheme'] === theme.id) apply()
    else revealTheme(root, apply)
    painted.current = true
  }, [theme.id, theme.scheme, prefs.wallpaper])

  useEffect(() => {
    writeCache(prefs)
    if (!persistence || !hydrated) return
    void persistence.save({ ...prefs, themeId: theme.id }).catch(() => undefined)
  }, [persistence, prefs, theme.id, hydrated])

  const setMode = useCallback((mode: ThemeMode) => {
    setPrefs((current) => ({ ...current, mode }))
  }, [])
  const setTheme = useCallback((id: ThemeId) => setMode(id), [setMode])
  const setWallpaper = useCallback((wallpaper: WallpaperSetting) => {
    setPrefs((current) => ({ ...current, wallpaper }))
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeId: theme.id,
      theme,
      setTheme,
      mode: prefs.mode,
      setMode,
      resolvedScheme: theme.scheme,
      wallpaper: prefs.wallpaper,
      setWallpaper,
    }),
    [theme, setTheme, prefs.mode, setMode, prefs.wallpaper, setWallpaper],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
