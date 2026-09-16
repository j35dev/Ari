import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, applyCachedTheme, useTheme } from './theme-provider'
import type { ThemePersistence } from './theme-provider'

/** Media-query stub: every listed query matches, everything else does not. */
function stubMatchMedia(matching: string[]): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: matching.some((m) => query.includes(m)),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  )
}

function Probe() {
  const {
    themeId,
    mode,
    resolvedScheme,
    setTheme,
    setMode,
    wallpaper,
    setWallpaper,
  } = useTheme()
  return (
    <div>
      <output data-testid="state">
        {`${themeId}|${mode}|${resolvedScheme}|${wallpaper}`}
      </output>
      <button onClick={() => setTheme('porcelain')}>light</button>
      <button onClick={() => setTheme('nocturne')}>nocturne</button>
      <button onClick={() => setMode('system')}>system</button>
      <button onClick={() => setWallpaper('anime-city')}>wallpaper on</button>
      <button onClick={() => setWallpaper('none')}>wallpaper off</button>
    </div>
  )
}

const root = () => document.documentElement.dataset

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear()
    stubMatchMedia(['prefers-color-scheme: dark'])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('follows the system scheme by default and applies html attributes', async () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    await waitFor(() => expect(root()['ariTheme']).toBe('obsidian'))
    expect(root()['ariScheme']).toBe('dark')
    expect(root()['ariGlass']).toBeUndefined()
    expect(screen.getByTestId('state')).toHaveTextContent('obsidian|system|dark|none')
  })

  it('picks the light theme when the OS prefers light', async () => {
    stubMatchMedia([])
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    await waitFor(() => expect(root()['ariTheme']).toBe('porcelain'))
    expect(root()['ariScheme']).toBe('light')
    expect(root()['ariGlass']).toBeUndefined()
  })

  it('swaps both attributes when a theme is pinned', async () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    const user = userEvent.setup()
    await user.click(screen.getByText('light'))
    await waitFor(() => expect(root()['ariTheme']).toBe('porcelain'))
    expect(root()['ariScheme']).toBe('light')
    expect(screen.getByTestId('state')).toHaveTextContent('porcelain|porcelain|light|none')

    await user.click(screen.getByText('system'))
    await waitFor(() => expect(root()['ariTheme']).toBe('obsidian'))
  })

  it('round-trips preferences through the injected persistence', async () => {
    const saved: unknown[] = []
    const persistence: ThemePersistence = {
      load: () => Promise.resolve({ mode: 'verdant', wallpaper: 'anime-city' }),
      save: (prefs) => {
        saved.push(prefs)
        return Promise.resolve()
      },
    }
    render(
      <ThemeProvider persistence={persistence}>
        <Probe />
      </ThemeProvider>,
    )
    await waitFor(() => expect(root()['ariTheme']).toBe('verdant'))
    await waitFor(() =>
      expect(saved).toContainEqual({
        mode: 'verdant',
        wallpaper: 'anime-city',
        themeId: 'verdant',
      }),
    )
    // localStorage keeps a pre-hydration cache so the next boot paints instantly.
    expect(localStorage.getItem('ari.theme')).toContain('verdant')
  })

  it('reflects the wallpaper selection as an html attribute and clears it for none', async () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    const user = userEvent.setup()
    await waitFor(() => expect(root()['ariTheme']).toBe('obsidian'))
    expect(root()['ariWallpaper']).toBeUndefined()

    await user.click(screen.getByText('wallpaper on'))
    await waitFor(() => expect(root()['ariWallpaper']).toBe('anime-city'))
    expect(screen.getByTestId('state')).toHaveTextContent('|anime-city')
    // One uniform look: no companion attribute to key variants off.
    expect(root()['ariWallpaperLook']).toBeUndefined()

    await user.click(screen.getByText('wallpaper off'))
    await waitFor(() => expect(root()['ariWallpaper']).toBeUndefined())
  })

  it('supplies the scene URL as a custom property, so the bundle resolves it', async () => {
    const style = () => document.documentElement.style
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    const user = userEvent.setup()
    await waitFor(() => expect(root()['ariTheme']).toBe('obsidian'))
    expect(style().getPropertyValue('--ari-wallpaper-image')).toBe('')

    // The CSS cannot carry `url('./assets/…')` itself: that path survives the
    // production build unhashed. The value here comes from the bundled import.
    await user.click(screen.getByText('wallpaper on'))
    await waitFor(() => {
      expect(style().getPropertyValue('--ari-wallpaper-image')).toMatch(/^url\(".+"\)$/)
    })
    expect(style().getPropertyValue('--ari-wallpaper-image')).toContain('anime-city')

    await user.click(screen.getByText('wallpaper off'))
    await waitFor(() => expect(style().getPropertyValue('--ari-wallpaper-image')).toBe(''))
  })

  it('paints the cached scene URL before React mounts', () => {
    localStorage.setItem(
      'ari.theme',
      JSON.stringify({ mode: 'obsidian', wallpaper: 'moon-landscape' }),
    )
    stubMatchMedia(['prefers-color-scheme: dark'])
    applyCachedTheme()
    expect(document.documentElement.style.getPropertyValue('--ari-wallpaper-image')).toContain(
      'moon-landscape',
    )
  })

  it('ignores a retired look field in the durable copy and the cache', async () => {
    const persistence: ThemePersistence = {
      load: () =>
        Promise.resolve({ mode: 'verdant', wallpaperLook: 'vivid' } as never),
      save: () => Promise.resolve(),
    }
    const { unmount } = render(
      <ThemeProvider persistence={persistence}>
        <Probe />
      </ThemeProvider>,
    )
    await waitFor(() => expect(root()['ariTheme']).toBe('verdant'))
    expect(root()['ariWallpaperLook']).toBeUndefined()
    unmount()
    localStorage.clear()

    localStorage.setItem(
      'ari.theme',
      JSON.stringify({ mode: 'verdant', wallpaper: 'anime-city', wallpaperLook: 'vivid' }),
    )
    applyCachedTheme()
    // The scene still paints pre-hydration; the stale look is simply ignored.
    expect(root()['ariWallpaper']).toBe('anime-city')
    expect(root()['ariWallpaperLook']).toBeUndefined()
  })

  it('never saves the cached default over the durable copy before it loads', async () => {
    const saved: unknown[] = []
    let release: (value: { mode: 'verdant' }) => void = () => undefined
    const pending = new Promise<{ mode: 'verdant' }>((resolve) => {
      release = resolve
    })
    const persistence: ThemePersistence = {
      load: () => pending,
      save: (prefs) => {
        saved.push(prefs)
        return Promise.resolve()
      },
    }
    render(
      <ThemeProvider persistence={persistence}>
        <Probe />
      </ThemeProvider>,
    )
    // The cache says 'system'; saving that now would erase the stored verdant.
    expect(saved).toEqual([])
    release({ mode: 'verdant' })
    await waitFor(() => expect(root()['ariTheme']).toBe('verdant'))
    expect(saved).toEqual([
      { mode: 'verdant', wallpaper: 'none', themeId: 'verdant' },
    ])
  })

  it('throws when useTheme is called outside the provider', () => {
    expect(() => render(<Probe />)).toThrow(/within ThemeProvider/)
  })
})

describe('applyCachedTheme', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset['ariTheme']
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('paints the cached theme before React mounts', () => {
    localStorage.setItem('ari.theme', JSON.stringify({ mode: 'porcelain', glass: true }))
    stubMatchMedia([])
    applyCachedTheme()
    expect(root()['ariTheme']).toBe('porcelain')
    expect(root()['ariScheme']).toBe('light')
    expect(root()['ariGlass']).toBeUndefined()
  })

  it('paints the cached wallpaper attribute before React mounts', () => {
    localStorage.setItem(
      'ari.theme',
      JSON.stringify({ mode: 'nocturne', wallpaper: 'moon-landscape' }),
    )
    stubMatchMedia(['prefers-color-scheme: dark'])
    applyCachedTheme()
    expect(root()['ariWallpaper']).toBe('moon-landscape')
  })

  it('drops a stale wallpaper cache value and leaves no attribute', () => {
    localStorage.setItem(
      'ari.theme',
      JSON.stringify({ mode: 'obsidian', wallpaper: 'aurora-borealis' }),
    )
    stubMatchMedia(['prefers-color-scheme: dark'])
    applyCachedTheme()
    expect(root()['ariWallpaper']).toBeUndefined()
  })

  it('falls back to the system theme with no cache', () => {
    stubMatchMedia(['prefers-color-scheme: dark'])
    applyCachedTheme()
    expect(root()['ariTheme']).toBe('obsidian')
    expect(root()['ariGlass']).toBeUndefined()
  })
})
