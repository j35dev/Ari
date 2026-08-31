import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { EndpointsManager } from './EndpointsManager'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

const invoke = rpcMocks.invoke as unknown as Mock<
  (method: string, params?: unknown) => Promise<unknown>
>

const SEED_STORED = {
  id: 'ep-1',
  name: 'Local llama',
  baseUrl: 'http://localhost:11434',
  flavor: 'openai-chat',
  model: 'llama3',
  models: [{ id: 'llama3', label: 'llama3', contextWindow: null, source: 'manual' }],
  apiKeyCipher: null,
}

function mockList(items: unknown[] = [SEED_STORED]): void {
  invoke.mockImplementation((method: string) => {
    if (method === 'endpoints.list') return Promise.resolve(items)
    return Promise.resolve({ ok: true })
  })
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('Name'), 'Local llama')
  await user.type(screen.getByLabelText('Base URL'), 'http://localhost:11434')
  await user.type(screen.getByLabelText('API key'), 'sk-test')
  await user.type(screen.getByLabelText('Model id to add to the new endpoint'), 'llama3')
  await user.click(screen.getByRole('button', { name: 'Add model to the new endpoint' }))
  await user.click(screen.getByRole('button', { name: 'Add endpoint' }))
}

describe('EndpointsManager', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('save routes through the engine endpoint store with the typed key', async () => {
    mockList([])
    invoke.mockImplementation((method: string) => {
      if (method === 'endpoints.list') return Promise.resolve([])
      if (method === 'endpoints.upsert') return Promise.resolve({ id: 'new-1', name: 'x' })
      return Promise.resolve({ ok: true })
    })
    const user = userEvent.setup()
    render(<EndpointsManager />)

    await fillAndSubmit(user)

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'endpoints.upsert',
        expect.objectContaining({
          name: 'Local llama',
          baseUrl: 'http://localhost:11434',
          flavor: 'openai-chat',
          model: 'llama3',
          models: [{ id: 'llama3', label: 'llama3', contextWindow: null, source: 'manual' }],
          apiKey: 'sk-test',
          headers: {},
        }),
      )
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('refuses to save an endpoint with no models', async () => {
    mockList([])
    const user = userEvent.setup()
    render(<EndpointsManager />)

    await user.type(screen.getByLabelText('Name'), 'Local llama')
    await user.type(screen.getByLabelText('Base URL'), 'http://localhost:11434')
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one model/i)
    expect(invoke).not.toHaveBeenCalledWith('endpoints.upsert', expect.anything())
  })

  it('editing with a blank key keeps the stored key (apiKey undefined)', async () => {
    mockList()
    const user = userEvent.setup()
    render(<EndpointsManager />)

    await user.click(await screen.findByRole('button', { name: 'Edit Local llama' }))
    // Add a second model and leave the key field empty.
    await user.type(screen.getByLabelText('Model id to add to this endpoint'), 'llama4')
    await user.click(screen.getByRole('button', { name: 'Add model to this endpoint' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'endpoints.upsert',
        expect.objectContaining({
          id: 'ep-1',
          model: 'llama3',
          apiKey: undefined,
          models: [
            { id: 'llama3', label: 'llama3', contextWindow: null, source: 'manual' },
            { id: 'llama4', label: 'llama4', contextWindow: null, source: 'manual' },
          ],
        }),
      )
    })
  })

  it('delete removes through the engine store and refreshes the list', async () => {
    let items: unknown[] = [SEED_STORED]
    invoke.mockImplementation((method: string) => {
      if (method === 'endpoints.list') return Promise.resolve(items)
      if (method === 'endpoints.remove') {
        items = []
        return Promise.resolve({ removed: true })
      }
      return Promise.resolve({ ok: true })
    })
    const user = userEvent.setup()
    render(<EndpointsManager />)
    expect(await screen.findByText('Local llama')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Delete Local llama' }))

    await waitFor(() => {
      expect(screen.queryByText('Local llama')).not.toBeInTheDocument()
    })
    expect(invoke).toHaveBeenCalledWith('endpoints.remove', { id: 'ep-1' })
  })

  it('test probes reachability in the main process', async () => {
    mockList()
    invoke.mockImplementation((method: string, params?: unknown) => {
      if (method === 'endpoints.list') return Promise.resolve([SEED_STORED])
      if (method === 'endpoints.test')
        return Promise.resolve({ ok: true, latencyMs: 42, message: 'connected' })
      void params
      return Promise.resolve({ ok: true })
    })
    const user = userEvent.setup()
    render(<EndpointsManager />)
    await screen.findByText('Local llama')

    await user.click(screen.getByRole('button', { name: 'Test Local llama' }))

    const status = await screen.findByRole('status')
    await waitFor(() => {
      expect(status.textContent).toContain('42ms')
    })
    expect(status.querySelector('.bg-success')).not.toBeNull()
    expect(invoke).toHaveBeenCalledWith(
      'endpoints.test',
      expect.objectContaining({ baseUrl: 'http://localhost:11434', flavor: 'openai-chat' }),
    )
  })

  it('test failure renders the main-process message', async () => {
    mockList()
    invoke.mockImplementation((method: string) => {
      if (method === 'endpoints.list') return Promise.resolve([SEED_STORED])
      if (method === 'endpoints.test')
        return Promise.resolve({ ok: false, latencyMs: 6, message: 'timed out' })
      return Promise.resolve({ ok: true })
    })
    const user = userEvent.setup()
    render(<EndpointsManager />)
    await screen.findByText('Local llama')

    await user.click(screen.getByRole('button', { name: 'Test Local llama' }))

    const status = await screen.findByRole('status')
    await waitFor(() => {
      expect(status.textContent).toContain('timed out')
    })
    expect(status.querySelector('.bg-danger')).not.toBeNull()
  })

  it('fetches models into the add form without saving them', async () => {
    invoke.mockImplementation((method: string) => {
      if (method === 'endpoints.list') return Promise.resolve([])
      if (method === 'endpoints.discoverModels') {
        return Promise.resolve({
          models: [
            { id: 'gpt-4o-mini', label: 'gpt-4o-mini', contextWindow: 128000, owner: 'openai' },
            { id: 'gpt-4o', label: 'gpt-4o', contextWindow: null, owner: 'openai' },
          ],
          error: null,
          saved: false,
        })
      }
      return Promise.resolve({ ok: true })
    })
    const user = userEvent.setup()
    render(<EndpointsManager />)

    await user.type(screen.getByLabelText('Base URL'), 'https://api.openai.com/v1')
    await user.click(screen.getByRole('button', { name: /fetch models for the new endpoint/i }))

    expect(await screen.findByText('gpt-4o-mini')).toBeInTheDocument()
    expect(screen.getByText('128k ctx')).toBeInTheDocument()
    // The probe is transient: nothing is persisted until the form is saved.
    expect(invoke).toHaveBeenCalledWith(
      'endpoints.discoverModels',
      expect.objectContaining({ baseUrl: 'https://api.openai.com/v1', flavor: 'openai-chat' }),
    )
    expect(invoke).not.toHaveBeenCalledWith('endpoints.upsert', expect.anything())
  })

  it('surfaces a discovery failure without clearing the form', async () => {
    invoke.mockImplementation((method: string) => {
      if (method === 'endpoints.list') return Promise.resolve([])
      if (method === 'endpoints.discoverModels') {
        return Promise.resolve({
          models: [],
          error: 'HTTP 401 — check the API key',
          saved: false,
        })
      }
      return Promise.resolve({ ok: true })
    })
    const user = userEvent.setup()
    render(<EndpointsManager />)

    await user.type(screen.getByLabelText('Base URL'), 'https://api.openai.com/v1')
    await user.click(screen.getByRole('button', { name: /fetch models for the new endpoint/i }))

    expect(await screen.findByRole('status')).toHaveTextContent('HTTP 401 — check the API key')
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.openai.com/v1')
  })

  it('refreshes a saved endpoint through the engine and re-reads the list', async () => {
    let items: unknown[] = [SEED_STORED]
    invoke.mockImplementation((method: string) => {
      if (method === 'endpoints.list') return Promise.resolve(items)
      if (method === 'endpoints.discoverModels') {
        items = [
          {
            ...SEED_STORED,
            models: [
              { id: 'llama3', label: 'llama3', contextWindow: null, source: 'manual' },
              { id: 'qwen3', label: 'qwen3', contextWindow: 32000, source: 'discovered' },
            ],
          },
        ]
        return Promise.resolve({
          models: [{ id: 'qwen3', label: 'qwen3', contextWindow: 32000, owner: null }],
          error: null,
          saved: true,
        })
      }
      return Promise.resolve({ ok: true })
    })
    const user = userEvent.setup()
    render(<EndpointsManager />)
    await screen.findByText('Local llama')

    await user.click(screen.getByRole('button', { name: /manage models for local llama/i }))
    await user.click(screen.getByRole('button', { name: /fetch models for Local llama/i }))

    expect(await screen.findByText('qwen3')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith(
      'endpoints.discoverModels',
      expect.objectContaining({ id: 'ep-1' }),
    )
    await waitFor(() => {
      expect(screen.getByText(/2 models · default llama3/)).toBeInTheDocument()
    })
  })

  it('persists a manual model added on a saved endpoint', async () => {
    mockList()
    const user = userEvent.setup()
    render(<EndpointsManager />)
    await screen.findByText('Local llama')

    await user.click(screen.getByRole('button', { name: /manage models for local llama/i }))
    await user.type(screen.getByLabelText('Model id to add to Local llama'), 'mistral')
    await user.click(screen.getByRole('button', { name: 'Add model to Local llama' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('endpoints.setModels', {
        id: 'ep-1',
        models: [
          { id: 'llama3', label: 'llama3', contextWindow: null, source: 'manual' },
          { id: 'mistral', label: 'mistral', contextWindow: null, source: 'manual' },
        ],
        defaultModel: 'llama3',
      })
    })
  })

  it('changes the default model of a saved endpoint', async () => {
    mockList([
      {
        ...SEED_STORED,
        models: [
          { id: 'llama3', label: 'llama3', contextWindow: null, source: 'manual' },
          { id: 'qwen3', label: 'qwen3', contextWindow: null, source: 'discovered' },
        ],
      },
    ])
    const user = userEvent.setup()
    render(<EndpointsManager />)
    await screen.findByText('Local llama')

    await user.click(screen.getByRole('button', { name: /manage models for local llama/i }))
    await user.click(screen.getByRole('radio', { name: /qwen3/ }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'endpoints.setModels',
        expect.objectContaining({ id: 'ep-1', defaultModel: 'qwen3' }),
      )
    })
  })

  it('removing the default model hands the role to the next one', async () => {
    mockList([
      {
        ...SEED_STORED,
        models: [
          { id: 'llama3', label: 'llama3', contextWindow: null, source: 'manual' },
          { id: 'qwen3', label: 'qwen3', contextWindow: null, source: 'discovered' },
        ],
      },
    ])
    const user = userEvent.setup()
    render(<EndpointsManager />)
    await screen.findByText('Local llama')

    await user.click(screen.getByRole('button', { name: /manage models for local llama/i }))
    await user.click(screen.getByRole('button', { name: 'Remove model llama3 from Local llama' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('endpoints.setModels', {
        id: 'ep-1',
        models: [{ id: 'qwen3', label: 'qwen3', contextWindow: null, source: 'discovered' }],
        defaultModel: 'qwen3',
      })
    })
  })
})
