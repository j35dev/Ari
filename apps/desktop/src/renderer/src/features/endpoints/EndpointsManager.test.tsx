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
  await user.type(screen.getByLabelText('Model'), 'llama3')
  await user.type(screen.getByLabelText('API key'), 'sk-test')
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
          apiKey: 'sk-test',
          headers: {},
        }),
      )
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('editing with a blank key keeps the stored key (apiKey undefined)', async () => {
    mockList()
    const user = userEvent.setup()
    render(<EndpointsManager />)

    await user.click(await screen.findByRole('button', { name: 'Edit Local llama' }))
    // Change only the model; leave the key field empty.
    const modelField = screen.getByLabelText('Model')
    await user.clear(modelField)
    await user.type(modelField, 'llama4')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'endpoints.upsert',
        expect.objectContaining({ id: 'ep-1', model: 'llama4', apiKey: undefined }),
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
})
