import { describe, expect, it } from 'vitest'
import { discoverModels, modelsPathFor, type DiscoveryFetch } from './model-discovery'

function jsonFetch(payload: unknown, status = 200): { fetch: DiscoveryFetch; calls: string[]; headers: Record<string, string>[] } {
  const calls: string[] = []
  const headers: Record<string, string>[] = []
  const fetchImpl: DiscoveryFetch = async (url, init) => {
    calls.push(url)
    headers.push(init.headers)
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => payload,
    }
  }
  return { fetch: fetchImpl, calls, headers }
}

describe('modelsPathFor', () => {
  it('maps each flavor to its listing path', () => {
    expect(modelsPathFor('openai-chat')).toBe('/models')
    expect(modelsPathFor('anthropic-messages')).toBe('/models')
    expect(modelsPathFor('ollama')).toBe('/api/tags')
  })
})

describe('discoverModels', () => {
  it('normalizes an OpenAI /v1/models payload and sends bearer auth', async () => {
    const { fetch, calls, headers } = jsonFetch({
      object: 'list',
      data: [
        { id: 'gpt-4o-mini', owned_by: 'openai', context_length: 128000 },
        { id: 'gpt-4o', owned_by: 'openai' },
      ],
    })
    const result = await discoverModels(
      { baseUrl: 'https://api.openai.com/v1/', flavor: 'openai-chat', apiKey: 'sk-test' },
      fetch,
    )
    expect(calls).toEqual(['https://api.openai.com/v1/models'])
    expect(headers[0]?.['authorization']).toBe('Bearer sk-test')
    expect(result.error).toBeNull()
    expect(result.models).toEqual([
      { id: 'gpt-4o', label: 'gpt-4o', contextWindow: null, owner: 'openai' },
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini', contextWindow: 128000, owner: 'openai' },
    ])
  })

  it('reads Ollama /api/tags shapes including nested family details', async () => {
    const { fetch, calls } = jsonFetch({
      models: [{ name: 'llama3.1:8b', details: { family: 'llama' } }],
    })
    const result = await discoverModels(
      { baseUrl: 'http://localhost:11434', flavor: 'ollama', apiKey: null },
      fetch,
    )
    expect(calls).toEqual(['http://localhost:11434/api/tags'])
    expect(result.models).toEqual([
      { id: 'llama3.1:8b', label: 'llama3.1:8b', contextWindow: null, owner: 'llama' },
    ])
  })

  it('sends anthropic auth headers and reads display names', async () => {
    const { fetch, headers } = jsonFetch({
      data: [{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4' }],
    })
    const result = await discoverModels(
      { baseUrl: 'https://api.anthropic.com/v1', flavor: 'anthropic-messages', apiKey: 'k' },
      fetch,
    )
    expect(headers[0]?.['x-api-key']).toBe('k')
    expect(headers[0]?.['anthropic-version']).toBe('2023-06-01')
    expect(result.models[0]?.label).toBe('Claude Sonnet 4')
  })

  it('reads OpenRouter-style nested context windows', async () => {
    const { fetch } = jsonFetch({
      data: [{ id: 'x/y', top_provider: { context_length: 200000 } }],
    })
    const result = await discoverModels(
      { baseUrl: 'https://openrouter.ai/api/v1', flavor: 'openai-chat', apiKey: null },
      fetch,
    )
    expect(result.models[0]?.contextWindow).toBe(200000)
  })

  it('deduplicates repeated ids', async () => {
    const { fetch } = jsonFetch({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] })
    const result = await discoverModels(
      { baseUrl: 'http://x/v1', flavor: 'openai-chat', apiKey: null },
      fetch,
    )
    expect(result.models.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('reports auth failures with an actionable hint', async () => {
    const { fetch } = jsonFetch({}, 401)
    const result = await discoverModels(
      { baseUrl: 'http://x/v1', flavor: 'openai-chat', apiKey: null },
      fetch,
    )
    expect(result.models).toEqual([])
    expect(result.error).toBe('HTTP 401 — check the API key')
  })

  it('reports servers without a listing endpoint', async () => {
    const { fetch } = jsonFetch({}, 404)
    const result = await discoverModels(
      { baseUrl: 'http://x/v1', flavor: 'openai-chat', apiKey: null },
      fetch,
    )
    expect(result.error).toBe('HTTP 404 — endpoint has no model listing')
  })

  it('never throws on transport failure', async () => {
    const failing: DiscoveryFetch = () => Promise.reject(new Error('ECONNREFUSED'))
    const result = await discoverModels(
      { baseUrl: 'http://x/v1', flavor: 'openai-chat', apiKey: null },
      failing,
    )
    expect(result).toEqual({ models: [], error: 'endpoint unreachable' })
  })

  it('reports an empty catalog rather than pretending to succeed', async () => {
    const { fetch } = jsonFetch({ data: [] })
    const result = await discoverModels(
      { baseUrl: 'http://x/v1', flavor: 'openai-chat', apiKey: null },
      fetch,
    )
    expect(result.error).toBe('endpoint returned no models')
  })
})
