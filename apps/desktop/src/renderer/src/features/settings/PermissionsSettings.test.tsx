import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@ari/contracts/settings'
import { PermissionsSettings } from './PermissionsSettings'

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

describe('PermissionsSettings', () => {
  beforeEach(() => {
    mocks.update.mockReset()
    mocks.update.mockResolvedValue(engineSettings)
    mocks.holder.settings = engineSettings
  })

  it('adds an allowlist entry via update and clears the draft', async () => {
    const user = userEvent.setup()
    render(<PermissionsSettings />)

    await user.type(screen.getByRole('textbox', { name: 'Command to always allow' }), 'git push')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(mocks.update).toHaveBeenCalledWith({ permissions: { allowlist: ['git push'] } })
    expect(screen.getByRole('textbox', { name: 'Command to always allow' })).toHaveValue('')
  })

  it('renders engine entries and removes one via update', async () => {
    mocks.holder.settings = { ...engineSettings, permissions: { allowlist: ['git push', 'ls'] } }
    const user = userEvent.setup()
    render(<PermissionsSettings />)

    expect(screen.getByText('git push')).toBeInTheDocument()
    expect(screen.getByText('ls')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove git push' }))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ permissions: { allowlist: ['ls'] } }),
    )
  })

  it('ignores duplicate or empty allowlist entries', async () => {
    mocks.holder.settings = { ...engineSettings, permissions: { allowlist: ['git push'] } }
    const user = userEvent.setup()
    render(<PermissionsSettings />)

    const input = screen.getByRole('textbox', { name: 'Command to always allow' })
    await user.type(input, 'git push')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.clear(input)
    await user.type(input, '   ')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('persists the default permission mode selection through the engine', async () => {
    const user = userEvent.setup()
    render(<PermissionsSettings />)

    expect(screen.getByRole('radio', { name: /Ask/ })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: /Full access/ }))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ sessions: { defaultPermissionMode: 'full' } }),
    )
  })
})
