import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@ari/contracts/settings'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { AppearanceSettings } from './AppearanceSettings'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  holder: { settings: null as Settings | null },
}))

vi.mock('./useEngineSettings', () => ({
  useEngineSettings: () => ({ settings: mocks.holder.settings, update: mocks.update }),
}))

const engineSettings: Settings = {
  version: 1,
  appearance: {
    themeId: 'obsidian',
    mode: 'system',
    glass: true,
    reducedMotion: false,
    wallpaper: 'none',
  },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  permissions: { allowlist: [] },
  window: null,
}

function renderPage() {
  return render(
    <ThemeProvider>
      <AppearanceSettings />
    </ThemeProvider>,
  )
}

describe('AppearanceSettings', () => {
  beforeEach(() => {
    mocks.update.mockReset()
    mocks.update.mockResolvedValue(engineSettings)
    mocks.holder.settings = engineSettings
    localStorage.clear()
  })

  it('lists every theme grouped by scheme, plus follow-system', () => {
    renderPage()
    expect(screen.getByRole('radiogroup', { name: 'Dark' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Light' })).toBeInTheDocument()
    for (const label of ['Obsidian', 'Graphite', 'Nocturne', 'Verdant', 'Porcelain', 'Sandstone']) {
      expect(screen.getByRole('radio', { name: new RegExp(label) })).toBeInTheDocument()
    }
    const followSystem = screen.getByRole('radio', { name: /Follow system/ })
    expect(followSystem).toHaveAttribute('aria-checked', 'true')
  })

  it('selects a theme and swaps the html attributes', async () => {
    renderPage()
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: /Porcelain/ }))

    await waitFor(() => {
      expect(document.documentElement.dataset['ariTheme']).toBe('porcelain')
    })
    expect(document.documentElement.dataset['ariScheme']).toBe('light')
    expect(screen.getByRole('radio', { name: /Porcelain/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('offers the glass toggle only for glass-capable themes', async () => {
    renderPage()
    const user = userEvent.setup()

    await user.click(screen.getByRole('radio', { name: /Nocturne/ }))
    const glass = await screen.findByRole('switch', { name: 'Glass chrome' })
    expect(glass).toHaveAttribute('aria-checked', 'true')

    await user.click(glass)
    await waitFor(() => {
      expect(document.documentElement.dataset['ariGlass']).toBe('off')
    })

    // Graphite is opaque by design — no toggle at all.
    await user.click(screen.getByRole('radio', { name: /Graphite/ }))
    await waitFor(() => {
      expect(screen.queryByRole('switch', { name: 'Glass chrome' })).not.toBeInTheDocument()
    })
  })

  it('lists every bundled wallpaper and applies the selection to the html attribute', async () => {
    renderPage()
    expect(screen.getByRole('radiogroup', { name: 'Wallpaper' })).toBeInTheDocument()
    for (const label of ['None', 'Anime City', 'Moon Landscape', 'Moon Landscape II']) {
      // "Moon Landscape" is a strict prefix of "Moon Landscape II" — exclude it.
      const pattern = label === 'Moon Landscape' ? /Moon Landscape(?! II)/ : new RegExp(label)
      expect(screen.getByRole('radio', { name: pattern })).toBeInTheDocument()
    }

    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: /Anime City/ }))
    await waitFor(() => {
      expect(document.documentElement.dataset['ariWallpaper']).toBe('anime-city')
    })
    expect(screen.getByRole('radio', { name: /Anime City/ })).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('radio', { name: /^None/ }))
    await waitFor(() => {
      expect(document.documentElement.dataset['ariWallpaper']).toBeUndefined()
    })
  })

  it('offers no visibility control — one uniform glass look per wallpaper', async () => {
    renderPage()
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: /Anime City/ }))
    await waitFor(() => {
      expect(document.documentElement.dataset['ariWallpaper']).toBe('anime-city')
    })
    expect(screen.queryByRole('group', { name: 'Wallpaper visibility' })).not.toBeInTheDocument()
    expect(document.documentElement.dataset['ariWallpaperLook']).toBeUndefined()
  })

  it('reflects the engine-backed reduced-motion value and toggles via update', async () => {
    mocks.holder.settings = {
      ...engineSettings,
      appearance: {
        themeId: 'obsidian',
        mode: 'system',
        glass: true,
        reducedMotion: true,
        wallpaper: 'none',
      },
    }
    renderPage()
    const toggle = screen.getByRole('switch', { name: 'Reduce motion' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    const user = userEvent.setup()
    await user.click(toggle)
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ appearance: { reducedMotion: false } }),
    )
  })
})
