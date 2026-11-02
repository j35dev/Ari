import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import type { Settings } from '@ari/contracts/settings'
import { SourceControlSettings } from './SourceControlSettings'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  invoke: vi.fn(),
  holder: { settings: null as Settings | null },
}))

vi.mock('./useEngineSettings', () => ({
  useEngineSettings: () => ({ settings: mocks.holder.settings, update: mocks.update }),
}))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mocks.invoke } }))

const tool = (detail: string, extra = {}) => ({
  installed: true,
  version: '2.0.0',
  account: null,
  detail,
  ...extra,
})

describe('SourceControlSettings', () => {
  beforeEach(() => {
    mocks.update.mockReset().mockResolvedValue(defaultSettings)
    mocks.holder.settings = { ...defaultSettings, version: 1 } as Settings
    mocks.invoke.mockReset().mockResolvedValue({
      git: tool('Ready.'),
      github: tool('Signed in as octo.', { account: 'octo' }),
      gitlab: { installed: false, version: null, account: null, detail: 'Install the GitLab CLI.' },
    })
  })

  it('saves Git action preferences', async () => {
    render(<SourceControlSettings />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('switch', { name: 'Open pull requests as drafts' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ sourceControl: { draftPullRequests: true } }),
    )
    await user.click(screen.getByRole('switch', { name: 'Confirm pushes to the default branch' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ sourceControl: { confirmDefaultPush: false } }),
    )
  })

  it('shows which tools are installed and signed in', async () => {
    render(<SourceControlSettings />)
    expect(await screen.findByText('Signed in as octo.')).toBeInTheDocument()
    expect(screen.getByText('Install the GitLab CLI.')).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('scm.environment')
  })
})
