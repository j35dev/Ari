import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EndpointsManager } from './EndpointsManager'

const SEED_ENDPOINT = {
  id: 'ep-1',
  name: 'Local llama',
  baseUrl: 'http://localhost:11434',
  flavor: 'openai-chat',
  model: 'llama3',
  apiKey: 'sk-test',
}

type ProbeResponse = { ok: boolean; status: number }

function seedStorage(): void {
  localStorage.setItem('ari.endpoints', JSON.stringify([SEED_ENDPOINT]))
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
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('save adds a card and persists the endpoint array', async () => {
    const user = userEvent.setup()
    render(<EndpointsManager />)

    await fillAndSubmit(user)

    expect(screen.getByText('Local llama')).toBeInTheDocument()
    expect(screen.getByText('http://localhost:11434')).toBeInTheDocument()

    const stored = JSON.parse(localStorage.getItem('ari.endpoints') ?? '[]') as Array<
      Record<string, unknown>
    >
    expect(stored).toHaveLength(1)
    const [first] = stored
    expect(first?.id).toEqual(expect.any(String))
    expect(first).toMatchObject({
      name: 'Local llama',
      baseUrl: 'http://localhost:11434',
      flavor: 'openai-chat',
      model: 'llama3',
      apiKey: 'sk-test',
    })
  })

  it('delete removes the card and empties storage', async () => {
    seedStorage()
    const user = userEvent.setup()
    render(<EndpointsManager />)

    await user.click(screen.getByRole('button', { name: 'Delete Local llama' }))

    expect(screen.queryByText('Local llama')).not.toBeInTheDocument()
    expect(localStorage.getItem('ari.endpoints')).toBe('[]')
  })

  it('test success renders measured latency and sends bearer auth', async () => {
    seedStorage()
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<ProbeResponse>>()
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<EndpointsManager />)

    await user.click(screen.getByRole('button', { name: 'Test Local llama' }))

    const status = await waitFor(() => {
      const node = screen.getByRole('status')
      expect(node.textContent).toMatch(/^\d+ms$/)
      return node
    })
    expect(status.querySelector('.bg-success')).not.toBeNull()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:11434/models')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer sk-test' },
    })
  })

  it('test failure renders unreachable', async () => {
    seedStorage()
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<ProbeResponse>>()
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<EndpointsManager />)

    await user.click(screen.getByRole('button', { name: 'Test Local llama' }))

    const status = await waitFor(() => {
      const node = screen.getByRole('status')
      expect(node.textContent).toBe('unreachable')
      return node
    })
    expect(status.querySelector('.bg-danger')).not.toBeNull()
  })
})
