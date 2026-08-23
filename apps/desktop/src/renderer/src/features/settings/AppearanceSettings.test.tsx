import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@ari/contracts/settings'
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
  appearance: { themeId: 'comet-glass', reducedMotion: false },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  permissions: { allowlist: [] },
  window: null,
}

describe('AppearanceSettings', () => {
  beforeEach(() => {
    mocks.update.mockReset()
    mocks.update.mockResolvedValue(engineSettings)
    mocks.holder.settings = engineSettings
  })

  it('describes the single glass appearance', () => {
    render(<AppearanceSettings />)
    expect(screen.getByText('Comet glass')).toBeInTheDocument()
    expect(screen.getByText(/frosted dark chrome/i)).toBeInTheDocument()
    expect(screen.getByText('Theme')).toBeInTheDocument()
  })

  it('reflects the engine-backed reduced-motion value and toggles via update', async () => {
    mocks.holder.settings = {
      ...engineSettings,
      appearance: { themeId: 'comet-glass', reducedMotion: true },
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
