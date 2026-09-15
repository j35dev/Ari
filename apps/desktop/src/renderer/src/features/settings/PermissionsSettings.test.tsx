import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@ari/contracts/settings'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
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
  delegation: delegationSettingsSchema.parse({}),
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

    expect(screen.getByRole('radio', { name: /Ask/ })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('radio', { name: /Full access/ }))

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ sessions: { defaultPermissionMode: 'full' } }),
    )
  })

  it('moves permission mode selection with arrow keys and wraps at the ends', async () => {
    const user = userEvent.setup()
    render(<PermissionsSettings />)

    const ask = screen.getByRole('radio', { name: /Ask/ })
    expect(ask).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: /Full access/ })).toHaveAttribute('tabindex', '-1')

    ask.focus()
    await user.keyboard('{ArrowDown}')
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        sessions: { defaultPermissionMode: 'allow-edits' },
      }),
    )
    expect(screen.getByRole('radio', { name: /Allow edits/ })).toHaveFocus()

    // Wraps backwards from the first card to the last.
    mocks.update.mockClear()
    ask.focus()
    await user.keyboard('{ArrowUp}')
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ sessions: { defaultPermissionMode: 'full' } }),
    )
    expect(screen.getByRole('radio', { name: /Full access/ })).toHaveFocus()
  })

  it('persists child-delegation switches, numbers, and selects', async () => {
    const user = userEvent.setup()
    render(<PermissionsSettings />)

    await user.click(screen.getByRole('switch', { name: 'Allow children to delegate' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ delegation: { recursiveDelegation: true } }),
    )

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Concurrent children per root' }), {
      target: { value: '6' },
    })
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ delegation: { maxConcurrentChildren: 6 } }),
    )

    await user.click(screen.getByRole('button', { name: 'Delegation approval' }))
    await user.click(screen.getByRole('option', { name: 'Every request' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ delegation: { approvalMode: 'always' } }),
    )
  })
})
