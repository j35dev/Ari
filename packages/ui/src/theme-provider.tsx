import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { customThemeSchema, type CustomTheme, type ThemeLibraryEvent } from '@ari/contracts/themes'
import { paintCustomTheme, resolveCustomTheme } from './custom-themes'
import { defaultThemeId, isThemeId, systemTheme, themes } from './themes'
import type { Theme } from './themes'
import { canBakeWallpaper, installWallpaperBake } from './wallpaper-bake'
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
export type ThemeMode = string

export interface ThemePreferences {
  mode: ThemeMode
  /** Bundled background scene shown behind the themed UI, or 'none'. */
  wallpaper: WallpaperSetting
  customThemes?: CustomTheme[]
  activeCustomTheme?: CustomTheme | null
}

/** Adapter onto durable storage (the engine settings store in the app). */
export interface ThemePersistence {
  load: () => Promise<Partial<ThemePreferences & { themeId: string }> | null>
  save: (prefs: ThemePreferences & { themeId: string }) => Promise<void>
  paint?: (themeId: string, customTheme?: CustomTheme) => Promise<void>
  subscribe?: (listener: (event: ThemeLibraryEvent) => void) => () => void
}

export interface ThemeContextValue {
  /** Id of the theme actually painted (resolved through `system`). */
  themeId: string
  /** Full palette of the painted theme. */
  theme: Theme
  /** Pins an explicit theme. */
  setTheme: (id: string) => void
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
  resolvedScheme: 'light' | 'dark'
  /** Active wallpaper selection ('none' = plain theme background). */
  wallpaper: WallpaperSetting
  setWallpaper: (wallpaper: WallpaperSetting) => void
  customThemes: CustomTheme[]
  activeCustomTheme: CustomTheme | null | undefined
  adoptLibrary: (event: ThemeLibraryEvent) => void
  previewTheme: (id: string) => void
  resetTheme: () => void
}

const STORAGE_KEY = 'ari.theme'

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readableTheme(value: unknown): CustomTheme | undefined {
  try {
    const parsed = customThemeSchema.parse(value)
    resolveCustomTheme(parsed)
    return parsed
  } catch {
    return undefined
  }
}
function readableLibrary(value: unknown): CustomTheme[] {
  return Array.isArray(value)
    ? value.slice(0, 50).flatMap((entry) => {
        const theme = readableTheme(entry)
        return theme ? [theme] : []
      })
    : []
}

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
        const {
          mode,
          wallpaper,
          customThemes: rawThemes,
          activeCustomTheme: rawActive,
        } = parsed as {
          mode?: unknown
          wallpaper?: unknown
          customThemes?: unknown
          activeCustomTheme?: unknown
        }
        const customThemes = readableLibrary(rawThemes)
        const activeCustomTheme = readableTheme(rawActive)
        return {
          mode:
            mode === 'system' || isThemeId(mode) || customThemes.some((theme) => theme.id === mode)
              ? (mode as string)
              : 'system',
          wallpaper: isWallpaperSetting(wallpaper) ? wallpaper : 'none',
          customThemes,
          activeCustomTheme,
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
  const custom =
    prefs.activeCustomTheme?.id === prefs.mode
      ? prefs.activeCustomTheme
      : prefs.customThemes?.find((entry) => entry.id === prefs.mode)
  const theme = custom
    ? resolveCustomTheme(custom)
    : prefs.mode === 'system'
      ? systemTheme(matches('(prefers-color-scheme: dark)'))
      : themes[isThemeId(prefs.mode) ? prefs.mode : defaultThemeId]
  const root = document.documentElement
  root.dataset['ariTheme'] = custom?.base ?? theme.id
  root.dataset['ariScheme'] = theme.scheme
  delete root.dataset['ariGlass']
  applyWallpaperAttr(root, prefs.wallpaper)
  paintCustomTheme(custom)
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
  const still = 'ariReducedMotion' in root.dataset || matches('(prefers-reduced-motion: reduce)')
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
  const [preview, setPreview] = useState<CustomTheme | null>(null)
  const [seconds, setSeconds] = useState(30)
  const [saveError, setSaveError] = useState(false)
  const saveGeneration = useRef(0)
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
          const customThemes = readableLibrary(stored.customThemes)
          setPrefs((current) => ({
            mode:
              stored.mode === 'system' ||
              isThemeId(stored.mode) ||
              customThemes.some((theme) => theme.id === stored.mode)
                ? stored.mode!
                : 'system',
            wallpaper: isWallpaperSetting(stored.wallpaper) ? stored.wallpaper : current.wallpaper,
            customThemes,
            activeCustomTheme:
              readableTheme(stored.activeCustomTheme) ??
              customThemes.find((entry) => entry.id === stored.mode),
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

  const custom =
    preview ??
    (prefs.activeCustomTheme?.id === prefs.mode
      ? prefs.activeCustomTheme
      : prefs.customThemes?.find((entry) => entry.id === prefs.mode))
  const theme = useMemo(
    () =>
      custom
        ? resolveCustomTheme(custom)
        : prefs.mode === 'system'
          ? systemTheme(prefersDark)
          : themes[isThemeId(prefs.mode) ? prefs.mode : defaultThemeId],
    [custom, prefs.mode, prefersDark],
  )
  const confirmedThemeId =
    prefs.mode === 'system'
      ? systemTheme(prefersDark).id
      : isThemeId(prefs.mode) || prefs.customThemes?.some((entry) => entry.id === prefs.mode)
        ? prefs.mode
        : defaultThemeId

  const adoptLibrary = useCallback((event: ThemeLibraryEvent) => {
    const customThemes = readableLibrary(event.themes)
    setPrefs((current) => ({
      ...current,
      customThemes,
      ...(event.reset ||
      (current.mode.startsWith('custom:') &&
        !customThemes.some((entry) => entry.id === current.mode))
        ? { mode: defaultThemeId, activeCustomTheme: null }
        : {}),
    }))
    setPreview((current) =>
      event.reset
        ? null
        : event.previewId
          ? (customThemes.find((entry) => entry.id === event.previewId) ?? null)
          : current && customThemes.some((entry) => entry.id === current.id)
            ? current
            : null,
    )
  }, [])
  useEffect(() => persistence?.subscribe?.(adoptLibrary), [persistence, adoptLibrary])
  useEffect(() => {
    if (!preview) return
    setSeconds(30)
    const deadline = Date.now() + 30_000
    const clock = window.setInterval(
      () => setSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000))),
      1000,
    )
    const revert = window.setTimeout(() => setPreview(null), 30_000)
    return () => {
      window.clearInterval(clock)
      window.clearTimeout(revert)
    }
  }, [preview])

  useEffect(() => {
    document.addEventListener('click', trackClick, true)
    return () => document.removeEventListener('click', trackClick, true)
  }, [])

  const painted = useRef(false)
  useEffect(() => {
    const root = document.documentElement
    const apply = (): void => {
      root.dataset['ariTheme'] = custom?.base ?? theme.id
      root.dataset['ariScheme'] = theme.scheme
      delete root.dataset['ariGlass']
      applyWallpaperAttr(root, prefs.wallpaper)
      paintCustomTheme(custom)
    }
    // The first run only confirms what applyCachedTheme already painted, and a
    // wallpaper change is not a theme change: neither is worth a transition.
    if (!painted.current || root.dataset['ariTheme'] === theme.id) apply()
    else revealTheme(root, apply)
    painted.current = true
  }, [theme, custom, prefs.wallpaper])
  useEffect(() => {
    void persistence?.paint?.(theme.id, custom).catch(() => undefined)
  }, [persistence, theme, custom])

  // Swap the live backdrop blur for a baked one (see wallpaper-bake.ts).
  useEffect(() => {
    const src = wallpapers.find((w) => w.id === prefs.wallpaper)?.src
    if (src === undefined || !canBakeWallpaper()) return
    return installWallpaperBake(document.documentElement, src)
  }, [prefs.wallpaper])

  useEffect(() => {
    writeCache(prefs)
    if (!persistence || !hydrated) return
    const generation = ++saveGeneration.current
    void persistence
      .save({
        mode: prefs.mode,
        wallpaper: prefs.wallpaper,
        themeId: confirmedThemeId,
        ...(prefs.activeCustomTheme !== undefined
          ? { activeCustomTheme: prefs.activeCustomTheme }
          : {}),
      })
      .then(
        () => {
          if (saveGeneration.current === generation) setSaveError(false)
        },
        () => {
          if (saveGeneration.current === generation) setSaveError(true)
        },
      )
  }, [persistence, prefs, confirmedThemeId, hydrated])

  const setMode = useCallback((mode: ThemeMode) => {
    setPreview(null)
    setPrefs((current) => {
      const next = current.customThemes?.find((entry) => entry.id === mode)
      return mode === 'system' || isThemeId(mode) || next
        ? {
            ...current,
            mode,
            activeCustomTheme: next ?? (current.activeCustomTheme ? null : undefined),
          }
        : current
    })
  }, [])
  const setTheme = useCallback((id: string) => setMode(id), [setMode])
  const previewTheme = useCallback(
    (id: string) => {
      setPreview(prefs.customThemes?.find((entry) => entry.id === id) ?? null)
    },
    [prefs.customThemes],
  )
  const resetTheme = useCallback(() => {
    setPreview(null)
    setPrefs((current) => ({
      ...current,
      mode: defaultThemeId,
      activeCustomTheme: null,
      wallpaper: 'none',
    }))
  }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.altKey &&
        event.shiftKey &&
        event.code === 'KeyT'
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        resetTheme()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [resetTheme])
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
      customThemes: prefs.customThemes ?? [],
      activeCustomTheme: prefs.activeCustomTheme,
      adoptLibrary,
      previewTheme,
      resetTheme,
    }),
    [
      theme,
      setTheme,
      prefs.mode,
      setMode,
      prefs.wallpaper,
      setWallpaper,
      prefs.customThemes,
      prefs.activeCustomTheme,
      adoptLibrary,
      previewTheme,
      resetTheme,
    ],
  )

  const recoveryButton = {
    padding: '5px 10px',
    border: '1px solid #526174',
    borderRadius: 6,
    background: '#233044',
    color: '#f4f8ff',
    font: 'inherit',
    cursor: 'pointer',
  }
  return (
    <ThemeContext.Provider value={value}>
      {children}
      {(custom || saveError) &&
        createPortal(
          <aside
            data-ari-theme-recovery=""
            aria-label="Theme recovery"
            style={{
              position: 'fixed',
              top: 48,
              right: 16,
              zIndex: 2147483647,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              maxWidth: 'calc(100vw - 32px)',
              padding: '10px 12px',
              border: '1px solid #526174',
              borderRadius: 10,
              background: '#101826',
              color: '#f4f8ff',
              font: '13px/1.5 system-ui, sans-serif',
              boxShadow: '0 8px 24px #00000066',
            }}
          >
            {preview ? (
              <>
                <span role="status">
                  Previewing {preview.name} · {seconds}s
                </span>
                <button
                  style={recoveryButton}
                  onClick={() => {
                    setPrefs((current) => ({
                      ...current,
                      mode: preview.id,
                      activeCustomTheme: preview,
                    }))
                    setPreview(null)
                  }}
                >
                  Keep theme
                </button>
                <button style={recoveryButton} onClick={() => setPreview(null)}>
                  Revert
                </button>
              </>
            ) : null}
            {saveError && (
              <span role="status">
                Could not save the theme choice. Check available disk space and try again.
              </span>
            )}
            <button style={recoveryButton} title="Ctrl/⌘+Alt+Shift+T" onClick={resetTheme}>
              Reset theme
            </button>
          </aside>,
          document.body,
        )}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
