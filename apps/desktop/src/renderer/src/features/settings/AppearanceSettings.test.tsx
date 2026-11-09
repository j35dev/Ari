import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import type { Settings } from '@ari/contracts/settings'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
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
  speech: defaultSettings.speech,
  version: 1,
  delegation: delegationSettingsSchema.parse({}),
  appearance: {
    ...defaultSettings.appearance,
    themeId: 'obsidian',
    mode: 'system',
    reducedMotion: false,
    wallpaper: 'none',
  },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  providers: defaultSettings.providers,
  sourceControl: {
    confirmDefaultPush: true,
    draftPullRequests: false,
    fetchIntervalSeconds: 60,
    diffView: 'split',
    wrapDiffLines: false,
  },
  notifications: { settleSound: true, desktop: true, discordPresence: true },
  permissions: { allowlist: [] },
  remote: { enabled: false, port: 8787, allowedOrigins: [] },
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
  it('offers only modest text sizes and starts at the released default scale', () => {
    renderPage()
    const select = screen.getByRole('combobox', { name: 'Text size' }) as HTMLSelectElement
    expect(select.value).toBe('16')
    expect(Array.from(select.options, (option) => Number(option.value))).toEqual([
      14, 15, 16, 17, 18,
    ])
  })
  it('offers bundled fonts, separate code faces, intermediate sizes, and full width', async () => {
    renderPage()
    const user = userEvent.setup()
    for (const label of [
      'JetBrains Mono',
      'Fira Code',
      'Manrope',
      'Source Sans 3',
      'Source Serif 4',
    ]) {
      expect(screen.getAllByRole('option', { name: label }).length).toBeGreaterThan(0)
    }
    await user.selectOptions(screen.getByRole('combobox', { name: 'Interface font' }), 'manrope')
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Code and terminal font' }),
      'jetbrains-mono',
    )
    await user.selectOptions(screen.getByRole('combobox', { name: 'Text size' }), '17')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Chat width' }), 'full')
    expect(mocks.update.mock.calls.map(([patch]) => patch)).toEqual([
      { appearance: { fontFamily: 'manrope' } },
      { appearance: { codeFont: 'jetbrains-mono' } },
      { appearance: { fontSize: 17 } },
      { appearance: { chatWidth: 'full' } },
    ])
  })
  it('persists font, scale, width, and terminal choices as independent patches', async () => {
    renderPage()
    const user = userEvent.setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Interface font' }), 'mono')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Text size' }), '18')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Chat width' }), 'wide')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Chat style' }), 'terminal')
    expect(mocks.update.mock.calls.map(([patch]) => patch)).toEqual([
      { appearance: { fontFamily: 'mono' } },
      { appearance: { fontSize: 18 } },
      { appearance: { chatWidth: 'wide' } },
      { appearance: { chatStyle: 'terminal' } },
    ])
  })
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
    expect(screen.getByRole('radio', { name: /Porcelain/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('lists every bundled wallpaper and applies the selection to the html attribute', async () => {
    renderPage()
    expect(screen.getByRole('radiogroup', { name: 'Wallpaper' })).toBeInTheDocument()
    for (const label of ['None', 'Anime City', 'Moon Landscape', 'Moon Landscape II']) {
      // "Moon Landscape" is a strict prefix of "Moon Landscape II" â€” exclude it.
      const pattern = label === 'Moon Landscape' ? /Moon Landscape(?! II)/ : new RegExp(label)
      expect(screen.getByRole('radio', { name: pattern })).toBeInTheDocument()
    }

    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: /Anime City/ }))
    await waitFor(() => {
      expect(document.documentElement.dataset['ariWallpaper']).toBe('anime-city')
    })
    expect(screen.getByRole('radio', { name: /Anime City/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await user.click(screen.getByRole('radio', { name: /^None/ }))
    await waitFor(() => {
      expect(document.documentElement.dataset['ariWallpaper']).toBeUndefined()
    })
  })

  it('offers no visibility control for wallpapers', async () => {
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
        ...engineSettings.appearance,
        themeId: 'obsidian',
        mode: 'system',
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
