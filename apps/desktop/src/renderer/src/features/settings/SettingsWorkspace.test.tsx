import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@ari/contracts/settings'
import { SettingsWorkspace, SETTINGS_SECTIONS } from './SettingsWorkspace'

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
  appearance: { themeId: 'obsidian', mode: 'system', glass: true, reducedMotion: false },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  permissions: { allowlist: [] },
  window: null,
}

describe('SettingsWorkspace', () => {
  beforeEach(() => {
    mocks.update.mockReset()
    mocks.update.mockResolvedValue(engineSettings)
    mocks.holder.settings = engineSettings
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue([])
  })

  it('uses a sidebar of sections, not a dump of every setting', () => {
    render(<SettingsWorkspace onBack={() => undefined} />)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument()
    for (const section of SETTINGS_SECTIONS) {
      expect(
        screen.getByRole('button', { name: section.label }),
      ).toBeInTheDocument()
    }
    expect(screen.queryByText('Detected providers')).not.toBeInTheDocument()
    expect(screen.queryByText('Export diagnostics')).not.toBeInTheDocument()
    expect(screen.getByText('Comet glass')).toBeInTheDocument()
  })

  it('switches the page from the sidebar', async () => {
    const user = userEvent.setup()
    render(<SettingsWorkspace onBack={() => undefined} />)

    await user.click(screen.getByRole('button', { name: 'Keybindings' }))
    expect(screen.getByRole('button', { name: 'Keybindings' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByText(/Every shortcut the workspace responds to/)).toBeInTheDocument()
    expect(screen.queryByText('Comet glass')).not.toBeInTheDocument()
  })

  it('returns to the session via Back', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<SettingsWorkspace onBack={onBack} />)

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledOnce()
  })
})
