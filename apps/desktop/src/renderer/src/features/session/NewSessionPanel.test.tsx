import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NewSessionPanel } from './NewSessionPanel'

const { invokeFn, modelsForFn } = vi.hoisted(() => ({
  invokeFn: vi.fn(),
  modelsForFn: vi.fn(),
}))

vi.mock('../../lib/rpc', () => ({
  rpc: {
    invoke: invokeFn,
    subscribe: vi.fn(() => () => undefined),
  },
}))

vi.mock('@ari/providers/catalogs', () => ({ modelsFor: modelsForFn }))

interface DetectionFixture {
  kind: string
  binaryPath: string | null
  version: string | null
  authStatus: string
}

const DETECTIONS: DetectionFixture[] = [
  {
    kind: 'claude',
    binaryPath: 'C:\\bin\\claude.exe',
    version: '2.1.0',
    authStatus: 'authenticated',
  },
  { kind: 'codex', binaryPath: null, version: null, authStatus: 'unknown' },
  {
    kind: 'opencode',
    binaryPath: '/usr/local/bin/opencode',
    version: '0.4.2',
    authStatus: 'unknown',
  },
]

const ENDPOINTS = [
  {
    id: 'ep-1',
    name: 'Local llama',
    baseUrl: 'http://localhost:11434',
    flavor: 'ollama',
    model: 'llama3',
    apiKeyCipher: null,
  },
]

function mockInvoke(): void {
  invokeFn.mockImplementation((method: string) => {
    if (method === 'providers.detect') return Promise.resolve(DETECTIONS)
    if (method === 'providers.models') return Promise.resolve([])
    if (method === 'endpoints.list') return Promise.resolve(ENDPOINTS)
    if (method === 'session.create') return Promise.resolve({ sessionId: 'sess_new' })
    return Promise.reject(new Error(`unexpected method ${method}`))
  })
}

describe('NewSessionPanel', () => {
  beforeEach(() => {
    invokeFn.mockReset()
    modelsForFn.mockReset()
    mockInvoke()
  })

  it('lists detected binaries plus ari-core as drivers and catalog entries as models', async () => {
    modelsForFn.mockReturnValue([
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', contextHint: '200k' },
    ])
    const user = userEvent.setup()
    render(<NewSessionPanel onSuccess={() => undefined} onCancel={() => undefined} />)

    // First detected binary becomes the default driver.
    await screen.findByRole('button', { name: 'Claude' })
    expect(modelsForFn).toHaveBeenCalledWith('claude')

    const drivers = await (async () => {
      await user.click(screen.getByRole('button', { name: 'Claude' }))
      return screen.getByRole('listbox')
    })()
    expect(within(drivers).getByRole('option', { name: 'Opencode' })).toBeInTheDocument()
    expect(within(drivers).getByRole('option', { name: 'Ari Core (built-in)' })).toBeInTheDocument()
    // codex was detected without a binary, so it must not appear.
    expect(within(drivers).queryByRole('option', { name: 'Codex' })).not.toBeInTheDocument()
    await user.click(within(drivers).getByRole('option', { name: 'Claude' }))

    await user.click(screen.getByRole('button', { name: 'Choose model' }))
    const models = screen.getByRole('listbox')
    expect(
      within(models).getByRole('option', { name: 'Claude Sonnet 4.5 · 200k' }),
    ).toBeInTheDocument()
  })

  it('create dispatches session.create with the assembled payload and reports the session id', async () => {
    modelsForFn.mockReturnValue([
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', contextHint: '200k' },
    ])
    const onSuccess = vi.fn()
    const user = userEvent.setup()
    render(<NewSessionPanel onSuccess={onSuccess} onCancel={() => undefined} />)

    await screen.findByRole('button', { name: 'Claude' })
    await user.type(screen.getByLabelText('Title'), 'Fix the flaky auth test')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(invokeFn).toHaveBeenCalledWith('session.create', {
        projectId: 'adhoc',
        title: 'Fix the flaky auth test',
        driverKind: 'claude',
        modelId: 'claude-sonnet-4-5',
        permissionMode: 'ask',
      })
    })
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('sess_new'))
  })

  it('ari-core lists endpoints as model entries and creates with the chosen endpoint', async () => {
    modelsForFn.mockReturnValue([])
    const onSuccess = vi.fn()
    const user = userEvent.setup()
    render(<NewSessionPanel onSuccess={onSuccess} onCancel={() => undefined} />)

    await screen.findByRole('button', { name: 'Claude' })
    await user.click(screen.getByRole('button', { name: 'Claude' }))
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: 'Ari Core (built-in)' }),
    )
    await waitFor(() => expect(invokeFn).toHaveBeenCalledWith('endpoints.list'))

    // Placeholder swaps to Choose model once endpoints arrive.
    const modelTrigger = await screen.findByRole('button', { name: 'Choose model' })
    await waitFor(() => expect(modelTrigger).toBeEnabled())
    await user.click(modelTrigger)
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: 'Local llama' }),
    )
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(invokeFn).toHaveBeenCalledWith('session.create', {
        projectId: 'adhoc',
        title: '',
        driverKind: 'ari-core',
        modelId: 'ep-1',
        permissionMode: 'ask',
      })
    })
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('sess_new'))
  })

  it('cancel invokes onCancel without creating a session', async () => {
    modelsForFn.mockReturnValue([])
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<NewSessionPanel onSuccess={() => undefined} onCancel={onCancel} />)

    await screen.findByRole('button', { name: 'Claude' })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(invokeFn).not.toHaveBeenCalledWith('session.create', expect.anything())
  })
})
