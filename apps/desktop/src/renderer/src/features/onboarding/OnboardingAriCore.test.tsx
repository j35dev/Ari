import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnboardingAriCore, type AriCoreConnection } from './OnboardingAriCore'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
}))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))

const model = (id: string) => ({ id, label: id, contextWindow: null, owner: null })
let ollama: { models: unknown[]; error: string | null }
let remote: { models: unknown[]; error: string | null }

afterEach(cleanup)
beforeEach(() => {
  ollama = { models: [], error: 'Connection refused' }
  remote = { models: [model('gpt-4o-mini'), model('gpt-4.1')], error: null }
  invoke.mockReset()
  invoke.mockImplementation(async (method, params) => {
    if (method === 'endpoints.discoverModels') {
      const { flavor } = params as { flavor: string }
      return { ...(flavor === 'ollama' ? ollama : remote), saved: false }
    }
    if (method === 'endpoints.upsert') return { id: 'ari-setup-openai', name: 'OpenAI' }
    if (method === 'settings.update') return {}
    throw new Error(method)
  })
})

const onContinue = vi.fn()
function Harness() {
  const [connection, setConnection] = useState<AriCoreConnection | null>(null)
  return (
    <OnboardingAriCore
      connection={connection}
      onConnected={setConnection}
      onBack={vi.fn()}
      onContinue={onContinue}
      headingRef={() => undefined}
      primaryRef={() => undefined}
    />
  )
}

describe('Ari Core setup', () => {
  it('does not save a key the provider refuses', async () => {
    remote = { models: [], error: 'HTTP 401 Unauthorized' }
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('radio', { name: /OpenAI/ }))
    await user.type(screen.getByLabelText('OpenAI API key'), 'sk-wrong')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 401 Unauthorized')
    expect(invoke).toHaveBeenCalledWith('endpoints.discoverModels', {
      baseUrl: 'https://api.openai.com/v1',
      flavor: 'openai-chat',
      apiKey: 'sk-wrong',
      persist: false,
    })
    expect(invoke).not.toHaveBeenCalledWith('endpoints.upsert', expect.anything())
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
  })

  it('asks for a key before checking anything', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Paste your OpenRouter API key first.')
    expect(
      invoke.mock.calls.filter(
        ([method, params]) =>
          method === 'endpoints.discoverModels' &&
          (params as { flavor: string }).flavor !== 'ollama',
      ),
    ).toHaveLength(0)
  })

  it('saves the endpoint with the listed models once the listing answers, then continues', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('radio', { name: /OpenAI/ }))
    await user.type(screen.getByLabelText('OpenAI API key'), 'sk-good{Enter}')
    expect(await screen.findByText(/Connected to OpenAI · 2 models/)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith(
      'endpoints.upsert',
      expect.objectContaining({
        id: 'ari-setup-openai',
        name: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
        apiKey: 'sk-good',
        models: [
          expect.objectContaining({ id: 'gpt-4o-mini', source: 'discovered' }),
          expect.objectContaining({ id: 'gpt-4.1', source: 'discovered' }),
        ],
      }),
    )
    expect(invoke).toHaveBeenCalledWith('settings.update', { ariCore: { enabled: true } })
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('offers Ollama only when it answers on this computer, without a key', async () => {
    const first = render(<Harness />)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'endpoints.discoverModels',
        expect.objectContaining({ flavor: 'ollama', baseUrl: 'http://localhost:11434' }),
      ),
    )
    expect(screen.queryByRole('radio', { name: /Ollama/ })).toBeNull()
    first.unmount()

    ollama = { models: [model('llama3.2')], error: null }
    const user = userEvent.setup()
    render(<Harness />)
    const local = await screen.findByRole('radio', { name: /Ollama/ })
    expect(local).toHaveAttribute('aria-checked', 'true')
    expect(local).toHaveTextContent('Running on this computer · 1 model')
    expect(screen.queryByLabelText(/API key/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText(/Connected to Ollama/)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith(
      'endpoints.upsert',
      expect.objectContaining({ flavor: 'ollama', apiKey: null, model: 'llama3.2' }),
    )
  })
})
