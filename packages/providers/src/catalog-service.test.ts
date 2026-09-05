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
  vi.useRealTimers()
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
  it('retries discovery on a later read without spawning a probe for every read', async () => {
    vi.useFakeTimers()
    const probeModels = vi.fn()
      .mockRejectedValueOnce(new Error('adapter not cached'))
      .mockResolvedValue([{ id: 'future-cli-model', label: 'New CLI model' }])
    const service = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      probeModels,
      probeKinds: ['codex'],
    })
    await Promise.all([service.refreshIfStale(), service.refreshIfStale()])
    await service.refreshIfStale()
    expect(probeModels).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await service.refreshIfStale()
    expect(probeModels).toHaveBeenCalledTimes(2)
    expect(modelsFor('codex')).toEqual([{ id: 'future-cli-model', label: 'New CLI model' }])
    await service.refreshIfStale()
    expect(probeModels).toHaveBeenCalledTimes(2)
  })

  it('retains the live catalog if a later probe fails after a registry refresh', async () => {
    const probeModels = vi.fn()
      .mockResolvedValueOnce([{ id: 'future-cli-model', label: 'New CLI model' }])
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
    const service = new CatalogService({
      fetchImpl: vi.fn().mockResolvedValue(registryResponse({
        openai: { models: { 'gpt-5.5': { name: 'Old fallback' } } },
      })) as unknown as typeof fetch,
      probeModels,
      probeKinds: ['codex'],
    })
    await service.refresh()
    await service.refresh()
    expect(catalogSource('codex')).toBe('live')
    expect(modelsFor('codex')).toEqual([{ id: 'future-cli-model', label: 'New CLI model' }])
  })

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

  it('notifies consumers after live ACP probes have settled', async () => {
    const onUpdated = vi.fn()
    const probeModels = vi.fn().mockResolvedValue([{ id: 'gpt-live', label: 'GPT Live' }])
    const service = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      probeModels,
      probeKinds: ['codex'],
      onUpdated,
    })

    await service.refresh()

    expect(probeModels).toHaveBeenCalledWith('codex')
    expect(onUpdated).toHaveBeenCalledOnce()
    expect(onUpdated).toHaveBeenCalledWith(expect.any(Number))
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
