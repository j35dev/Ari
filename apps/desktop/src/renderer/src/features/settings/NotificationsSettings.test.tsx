import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@ari/contracts/settings'
import { NotificationsSettings } from './NotificationsSettings'

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
  notifications: { settleSound: true },
  permissions: { allowlist: [] },
  window: null,
}

describe('NotificationsSettings', () => {
  beforeEach(() => {
    mocks.update.mockReset()
    mocks.update.mockResolvedValue(engineSettings)
    mocks.holder.settings = engineSettings
  })

  it('defaults the switch to on while settings load', () => {
    mocks.holder.settings = null
    render(<NotificationsSettings />)
    expect(screen.getByRole('switch', { name: 'Completion sound' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('reflects the engine-backed value and toggles via update', async () => {
    mocks.holder.settings = {
      ...engineSettings,
      notifications: { settleSound: false },
    }
    render(<NotificationsSettings />)
    const toggle = screen.getByRole('switch', { name: 'Completion sound' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    const user = userEvent.setup()
    await user.click(toggle)
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ notifications: { settleSound: true } }),
    )
  })
})
