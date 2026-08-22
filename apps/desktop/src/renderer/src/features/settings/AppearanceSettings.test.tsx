import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { THEMES } from '@ari/ui/theme-provider'
import type * as ThemeProviderModule from '@ari/ui/theme-provider'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@ari/contracts/settings'
import { AppearanceSettings } from './AppearanceSettings'

const mocks = vi.hoisted(() => ({
  setTheme: vi.fn(),
  update: vi.fn(),
  holder: { settings: null as Settings | null },
}))

vi.mock('./useEngineSettings', () => ({
  useEngineSettings: () => ({ settings: mocks.holder.settings, update: mocks.update }),
}))

vi.mock('@ari/ui/theme-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof ThemeProviderModule>()),
  useTheme: () => ({ theme: 'obsidian', setTheme: mocks.setTheme }),
}))

const engineSettings: Settings = {
  version: 1,
  appearance: { themeId: 'obsidian', reducedMotion: false },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  permissions: { allowlist: [] },
  window: null,
}

describe('AppearanceSettings', () => {
  beforeEach(() => {
    mocks.setTheme.mockClear()
    mocks.update.mockReset()
    mocks.update.mockResolvedValue(engineSettings)
    mocks.holder.settings = engineSettings
  })

  it('renders one preview card per theme', () => {
    render(<AppearanceSettings />)
    for (const t of THEMES) {
      expect(screen.getByRole('button', { name: t.label })).toBeInTheDocument()
    }
  })

  it('applies the picked theme and persists it through the engine', async () => {
    const user = userEvent.setup()
    render(<AppearanceSettings />)
    await user.click(screen.getByRole('button', { name: 'Ember' }))
    expect(mocks.setTheme).toHaveBeenCalledOnce()
    expect(mocks.setTheme).toHaveBeenCalledWith('ember')
    expect(mocks.update).toHaveBeenCalledWith({ appearance: { themeId: 'ember' } })
  })

  it('reflects the engine-backed reduced-motion value and toggles via update', async () => {
    mocks.holder.settings = {
      ...engineSettings,
      appearance: { themeId: 'obsidian', reducedMotion: true },
    }
    render(<AppearanceSettings />)
    const toggle = screen.getByRole('switch', { name: 'Reduce motion' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    const user = userEvent.setup()
    await user.click(toggle)
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ appearance: { reducedMotion: false } }),
    )
  })
})
