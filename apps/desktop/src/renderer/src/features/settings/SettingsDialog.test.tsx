import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@ari/contracts/settings'
import { SettingsDialog, SETTINGS_SECTIONS } from './SettingsDialog'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  holder: { settings: null as Settings | null },
  invoke: vi.fn(),
}))

vi.mock('./useEngineSettings', () => ({
  useEngineSettings: () => ({ settings: mocks.holder.settings, update: mocks.update }),
}))

vi.mock('../../lib/rpc', () => ({
  rpc: {
    invoke: mocks.invoke,
    subscribe: vi.fn(() => () => undefined),
  },
}))

const engineSettings: Settings = {
  version: 1,
  appearance: { themeId: 'comet-glass', reducedMotion: false },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  permissions: { allowlist: [] },
  window: null,
}

describe('SettingsDialog', () => {
  beforeEach(() => {
    mocks.update.mockReset()
    mocks.update.mockResolvedValue(engineSettings)
    mocks.holder.settings = engineSettings
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue([])
  })

  it('renders as an overlay dialog with every settings section in the nav', () => {
    render(<SettingsDialog open onOpenChange={() => undefined} />)

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    for (const section of SETTINGS_SECTIONS) {
      expect(screen.getByRole('tab', { name: section.label })).toBeInTheDocument()
    }
    expect(screen.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Comet glass')).toBeInTheDocument()
  })

  it('switches the panel when a section tab is chosen', async () => {
    const user = userEvent.setup()
    render(<SettingsDialog open onOpenChange={() => undefined} />)

    await user.click(screen.getByRole('tab', { name: 'Keybindings' }))
    expect(screen.getByRole('tab', { name: 'Keybindings' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByText(/Every shortcut the workspace responds to/)).toBeInTheDocument()
    expect(screen.queryByText('Comet glass')).not.toBeInTheDocument()
  })

  it('does not render when closed, so the session pane stays visible', () => {
    render(<SettingsDialog open={false} onOpenChange={() => undefined} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
