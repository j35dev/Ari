import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlackSnapshot } from '@ari/contracts/slack'
import { slackAppManifest } from '@ari/contracts/slack'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { SlackSettings } from './SlackSettings'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => undefined) }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
let state: SlackSnapshot

beforeEach(() => {
  state = {
    status: 'disconnected',
    message: null,
    enabled: false,
    hasCredentials: false,
    secureStorageAvailable: true,
    workspace: null,
    ownerUserId: '',
    permissionMode: 'ask',
    routes: [],
    taskCount: 0,
    uncertainRequests: 0,
    uncertainDeliveries: 0,
    projects: [
      {
        id: 'project_one',
        name: 'Ari',
        ready: true,
        reason: null,
        defaultAgent: {
          driverKind: 'claude',
          modelId: 'fixture-model',
          effort: 'high',
          permissionMode: 'ask',
        },
      },
    ],
    providers: [
      {
        driverKind: 'claude',
        available: true,
        models: [{ id: 'fixture-model', efforts: ['low', 'high'] }],
      },
    ],
  }
  mocks.invoke.mockReset()
  mocks.subscribe.mockClear()
  mocks.invoke.mockImplementation((method: string, params?: unknown) => {
    if (method === 'slack.configure')
      return Promise.resolve({
        ok: true,
        snapshot: {
          ...state,
          ...(params as {
            ownerUserId: string
            permissionMode: 'ask'
            routes: SlackSnapshot['routes']
          }),
          status: 'connected',
          enabled: true,
          hasCredentials: true,
          workspace: { id: 'TTEAM123', name: 'Fixture team', botUserId: 'UBOT123' },
        },
      })
    if (method === 'slack.disconnect')
      return Promise.resolve({
        ok: true,
        snapshot: { ...state, enabled: false, status: 'disconnected' },
      })
    return Promise.resolve(state)
  })
})

function page() {
  return render(
    <ThemeProvider>
      <SlackSettings />
    </ThemeProvider>,
  )
}

describe('Slack connection setup', () => {
  it('requires an explicit member and channel mapping, connects, and clears token inputs', async () => {
    const user = userEvent.setup()
    page()
    await screen.findByLabelText('Your Slack member ID')
    await user.type(screen.getByLabelText('Bot OAuth token'), 'xoxb-fixture-token')
    await user.type(screen.getByLabelText('App-level token'), 'xapp-fixture-token')
    await user.type(screen.getByLabelText('Your Slack member ID'), 'UOWNER123')
    await user.type(screen.getByLabelText('Channel ID 1'), 'CROOM123')
    await user.selectOptions(screen.getByLabelText('Project 1'), 'project_one')
    await user.click(screen.getByRole('button', { name: 'Connect Slack' }))
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('slack.configure', {
        botToken: 'xoxb-fixture-token',
        appToken: 'xapp-fixture-token',
        ownerUserId: 'UOWNER123',
        permissionMode: 'ask',
        routes: [{ channelId: 'CROOM123', projectId: 'project_one' }],
      }),
    )
    await screen.findByText('Connected')
    expect(screen.getByLabelText('Bot OAuth token')).toHaveValue('')
    expect(screen.getByLabelText('App-level token')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
    expect(
      screen.getByText(/Only this Slack member can start or control tasks/),
    ).toBeInTheDocument()
  })

  it('keeps saved credentials when their fields are left blank', async () => {
    state = {
      ...state,
      status: 'connected',
      enabled: true,
      hasCredentials: true,
      ownerUserId: 'UOWNER123',
      routes: [{ channelId: 'CROOM123', projectId: 'project_one' }],
      workspace: { id: 'TTEAM123', name: 'Fixture team', botUserId: 'UBOT123' },
    }
    const user = userEvent.setup()
    page()
    await screen.findByRole('button', { name: 'Save and reconnect' })
    await user.click(screen.getByRole('button', { name: 'Save and reconnect' }))
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('slack.configure', {
        ownerUserId: 'UOWNER123',
        permissionMode: 'ask',
        routes: [{ channelId: 'CROOM123', projectId: 'project_one' }],
      }),
    )
  })

  it('does not invoke connection when member IDs or channel mappings are invalid', async () => {
    const user = userEvent.setup()
    page()
    await screen.findByRole('button', { name: 'Connect Slack' })
    await user.click(screen.getByRole('button', { name: 'Connect Slack' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Slack member ID')
    expect(mocks.invoke.mock.calls.some(([method]) => method === 'slack.configure')).toBe(false)
  })

  it('refuses connection when OS-backed secure storage is unavailable', async () => {
    state.secureStorageAvailable = false
    page()
    expect(await screen.findByRole('button', { name: 'Connect Slack' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('OS-backed secure storage is unavailable')
  })

  it('copies the complete manifest without any tokens', async () => {
    const user = userEvent.setup()
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText')
    page()
    await user.click(screen.getByRole('button', { name: 'Copy app manifest' }))
    await waitFor(() =>
      expect(clipboard).toHaveBeenCalledWith(JSON.stringify(slackAppManifest, null, 2)),
    )
    expect(await screen.findByRole('button', { name: 'Manifest copied' })).toBeInTheDocument()
  })

  it('saves a project default only after explicit selection and preserves unsaved channel setup', async () => {
    state.projects[0] = {
      ...state.projects[0]!,
      ready: false,
      reason: 'Choose an agent.',
      defaultAgent: null,
    }
    mocks.invoke.mockImplementation((method: string) => {
      if (method === 'project.setDefaultAgent') {
        state.projects[0] = {
          ...state.projects[0]!,
          ready: true,
          reason: null,
          defaultAgent: {
            driverKind: 'claude',
            modelId: 'fixture-model',
            effort: 'high',
            permissionMode: 'ask',
          },
        }
        return Promise.resolve({ id: 'project_one' })
      }
      return Promise.resolve(state)
    })
    const user = userEvent.setup()
    page()
    await screen.findByLabelText('Project 1')
    await user.type(screen.getByLabelText('Your Slack member ID'), 'UOWNER123')
    await user.type(screen.getByLabelText('Channel ID 1'), 'CROOM123')
    await user.selectOptions(screen.getByLabelText('Project 1'), 'project_one')
    await user.click(screen.getByRole('button', { name: 'Choose default agent' }))
    expect(mocks.invoke.mock.calls.some(([method]) => method === 'project.setDefaultAgent')).toBe(
      false,
    )
    await user.selectOptions(screen.getByLabelText('Default project agent'), 'claude')
    await user.selectOptions(screen.getByLabelText('Default project model'), 'fixture-model')
    await user.selectOptions(screen.getByLabelText('Default project effort'), 'high')
    await user.click(screen.getByRole('button', { name: 'Save default agent' }))
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('project.setDefaultAgent', {
        id: 'project_one',
        value: {
          driverKind: 'claude',
          modelId: 'fixture-model',
          effort: 'high',
          permissionMode: 'ask',
        },
      }),
    )
    expect(screen.getByLabelText('Channel ID 1')).toHaveValue('CROOM123')
    expect(screen.getByLabelText('Your Slack member ID')).toHaveValue('UOWNER123')
  })
})
