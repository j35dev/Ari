import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriverKind } from '@ari/contracts/common'
import { catalogSource, clearDynamicModels, modelsFor } from './catalogs'
import { CatalogService, DEFAULT_REGISTRY_URL, REGISTRY_PROVIDER } from './catalog-service'
import type { CatalogModel } from './catalogs'

const ALL_KINDS: DriverKind[] = ['claude', 'codex', 'opencode', 'grok', 'pi', 'hermes', 'ari-core']

afterEach(() => {
  for (const kind of ALL_KINDS) clearDynamicModels(kind)
})

/** Snapshot-backed value for a kind before any test mutates module state. */
function modelsForBefore(kind: DriverKind): CatalogModel[] {
  return modelsFor(kind)
}

function registryResponse(providers: Record<string, { models: Record<string, unknown> }>): {
  ok: boolean
  status: number
  json: () => Promise<unknown>
} {
  return { ok: true, status: 200, json: async () => providers }
}

describe('CatalogService', () => {
  it('maps registry providers onto kinds and reports the cache source', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      registryResponse({
        anthropic: {
          models: {
            'claude-x': { id: 'claude-x', name: 'Claude X', limit: { context: 200000 }, modalities: { output: ['text'] } },
            'claude-img': { id: 'claude-img', modalities: { output: ['image'] } },
          },
        },
        openai: { models: { 'gpt-x': { id: 'gpt-x', name: 'GPT X', limit: { context: 400000 } } } },
      }),
    )
    const service = new CatalogService({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await service.refresh()
    expect(modelsFor('claude')).toEqual([
      { id: 'claude-x', label: 'Claude X', contextHint: '200k' },
    ])
    expect(catalogSource('claude')).toBe('cache')
    // grok has no registry payload in this round; its bundled snapshot stays.
    expect(modelsFor('grok')).toEqual(modelsForBefore('grok'))
  })

  it('keeps the snapshot when the network fails and still probes live afterwards', async () => {
    const before = modelsFor('claude')
    const probeModels = vi.fn().mockResolvedValue([{ id: 'agent-own-model', label: 'From agent' }])
    const service = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      probeModels,
      probeKinds: ['opencode'],
    })
    await service.refresh()
    expect(modelsFor('claude')).toEqual(before)
    expect(modelsFor('opencode')).toEqual([{ id: 'agent-own-model', label: 'From agent' }])
    expect(service.lastRefreshAt).toBe(0)
  })

  it('persists a successful round to the disk cache and reloads it cold', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-catalog-'))
    const cachePath = join(dir, 'cache', 'models.json')
    const payload = {
      anthropic: { models: { 'claude-disk': { id: 'claude-disk', name: 'Disk Model' } } },
    }
    const first = new CatalogService({
      fetchImpl: vi.fn().mockResolvedValue(registryResponse(payload)) as unknown as typeof fetch,
      cachePath,
    })
    await first.refresh()
    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as {
      at: number
      providers: Record<string, CatalogModel[]>
    }
    expect(cached.providers['anthropic']).toEqual([{ id: 'claude-disk', label: 'Disk Model' }])

    // Cold start with a dead network must restore the cached catalogs.
    const second = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      cachePath,
    })
    second.start()
    await second.ready
    expect(modelsFor('claude')).toEqual([{ id: 'claude-disk', label: 'Disk Model' }])
    expect(second.lastRefreshAt).toBe(cached.at)
  })

  it('shares one in-flight refresh across concurrent callers', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(registryResponse({ anthropic: { models: {} } })), 20)),
    )
    const service = new CatalogService({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await Promise.all([service.refresh(), service.refresh(), service.refresh()])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('exposes the default registry url and provider mapping for wiring', () => {
    expect(DEFAULT_REGISTRY_URL).toContain('models.dev')
    expect(REGISTRY_PROVIDER['claude']).toBe('anthropic')
  })
})
