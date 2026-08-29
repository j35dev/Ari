import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { defaultThemeId, isThemeId, systemTheme, themes } from './themes'
import type { Theme, ThemeId } from './themes'
import { isWallpaperLook, isWallpaperSetting } from './wallpapers'
import type { WallpaperLookId, WallpaperSetting } from './wallpapers'

/**
 * Theme engine. Owns the active theme, the `system` follow mode, the glass
 * opt-in, and the wallpaper selection (scene + visibility look), and reflects
 * them onto `<html>` as `data-ari-theme`, `data-ari-scheme`,
 * `data-ari-glass`, `data-ari-wallpaper` and `data-ari-wallpaper-look` — the
 * hooks tokens.css, glass.css and wallpaper.css key off, so no component
 * needs to know which theme is active.
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
  /** Glass opt-in; only glass-capable themes act on it. */
  glass: boolean
  /** Bundled background scene composited under the themed UI. */
  wallpaper: WallpaperSetting
  /** How strongly the scene shows through; only meaningful with one set. */
  wallpaperLook: WallpaperLookId
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
  /** True when translucent chrome is actually in effect. */
  glassEnabled: boolean
  /** The raw opt-in, independent of theme capability / reduced transparency. */
  glassPreference: boolean
  setGlass: (enabled: boolean) => void
  /** Active wallpaper selection ('none' = plain theme background). */
  wallpaper: WallpaperSetting
  setWallpaper: (wallpaper: WallpaperSetting) => void
  /** Wallpaper visibility look; only meaningful while a scene is active. */
  wallpaperLook: WallpaperLookId
  setWallpaperLook: (look: WallpaperLookId) => void
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
        const { mode, glass, wallpaper, wallpaperLook } = parsed as {
          mode?: unknown
          glass?: unknown
          wallpaper?: unknown
          wallpaperLook?: unknown
        }
        return {
          mode: mode === 'system' || isThemeId(mode) ? mode : 'system',
          glass: typeof glass === 'boolean' ? glass : true,
          wallpaper: isWallpaperSetting(wallpaper) ? wallpaper : 'none',
          wallpaperLook: isWallpaperLook(wallpaperLook) ? wallpaperLook : 'balanced',
        }
      }
    }
  } catch {
    // storage unavailable or corrupt — defaults apply
  }
  return { mode: 'system', glass: true, wallpaper: 'none', wallpaperLook: 'balanced' }
}

function writeCache(prefs: ThemePreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // non-fatal: preferences simply won't survive a reload
  }
}

/**
 * Reflects the wallpaper selection onto `<html>` for wallpaper.css. The
 * attribute is present only while a scene is active, so every wallpaper rule
 * is opt-in and 'none' restores the plain theme exactly. The look rides along
 * so CSS can key the veil strength off `[data-ari-wallpaper-look]`.
 */
function applyWallpaperAttrs(
  root: HTMLElement,
  wallpaper: WallpaperSetting,
  wallpaperLook: WallpaperLookId,
): void {
  if (wallpaper === 'none') {
    delete root.dataset['ariWallpaper']
    delete root.dataset['ariWallpaperLook']
  } else {
    root.dataset['ariWallpaper'] = wallpaper
    root.dataset['ariWallpaperLook'] = wallpaperLook
  }
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
  const theme = prefs.mode === 'system' ? systemTheme(matches('(prefers-color-scheme: dark)')) : themes[prefs.mode]
  const root = document.documentElement
  root.dataset['ariTheme'] = theme.id
  root.dataset['ariScheme'] = theme.scheme
  const glass = theme.glass && prefs.glass && !matches('(prefers-reduced-transparency: reduce)')
  root.dataset['ariGlass'] = glass ? 'on' : 'off'
  applyWallpaperAttrs(root, prefs.wallpaper, prefs.wallpaperLook)
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
  const reducedTransparency = useMediaQuery('(prefers-reduced-transparency: reduce)')
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
            glass: typeof stored.glass === 'boolean' ? stored.glass : current.glass,
            wallpaper: isWallpaperSetting(stored.wallpaper) ? stored.wallpaper : current.wallpaper,
            wallpaperLook: isWallpaperLook(stored.wallpaperLook)
              ? stored.wallpaperLook
              : current.wallpaperLook,
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
    prefs.mode === 'system' ? systemTheme(prefersDark) : (themes[prefs.mode] ?? themes[defaultThemeId])
  const glassEnabled = theme.glass && prefs.glass && !reducedTransparency

  useEffect(() => {
    const root = document.documentElement
    root.dataset['ariTheme'] = theme.id
    root.dataset['ariScheme'] = theme.scheme
    root.dataset['ariGlass'] = glassEnabled ? 'on' : 'off'
    applyWallpaperAttrs(root, prefs.wallpaper, prefs.wallpaperLook)
  }, [theme.id, theme.scheme, glassEnabled, prefs.wallpaper, prefs.wallpaperLook])

  useEffect(() => {
    writeCache(prefs)
    if (!persistence || !hydrated) return
    void persistence.save({ ...prefs, themeId: theme.id }).catch(() => undefined)
  }, [persistence, prefs, theme.id, hydrated])

  const setMode = useCallback((mode: ThemeMode) => {
    setPrefs((current) => ({ ...current, mode }))
  }, [])
  const setTheme = useCallback((id: ThemeId) => setMode(id), [setMode])
  const setGlass = useCallback((glass: boolean) => {
    setPrefs((current) => ({ ...current, glass }))
  }, [])
  const setWallpaper = useCallback((wallpaper: WallpaperSetting) => {
    setPrefs((current) => ({ ...current, wallpaper }))
  }, [])
  const setWallpaperLook = useCallback((wallpaperLook: WallpaperLookId) => {
    setPrefs((current) => ({ ...current, wallpaperLook }))
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeId: theme.id,
      theme,
      setTheme,
      mode: prefs.mode,
      setMode,
      resolvedScheme: theme.scheme,
      glassEnabled,
      glassPreference: prefs.glass,
      setGlass,
      wallpaper: prefs.wallpaper,
      setWallpaper,
      wallpaperLook: prefs.wallpaperLook,
      setWallpaperLook,
    }),
    [
      theme,
      setTheme,
      prefs.mode,
      setMode,
      glassEnabled,
      prefs.glass,
      setGlass,
      prefs.wallpaper,
      setWallpaper,
      prefs.wallpaperLook,
      setWallpaperLook,
    ],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
