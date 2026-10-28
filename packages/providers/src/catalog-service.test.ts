import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriverKind } from '@ari/contracts/common'
import {
  agentDefaultModel,
  catalogSource,
  clearDynamicEfforts,
  clearDynamicModels,
  effortsFor,
  modelsFor,
  setAgentDefaultModel,
  setDynamicEfforts,
  setDynamicModels,
} from './catalogs'
import {
  CatalogService,
  DEFAULT_REGISTRY_URL,
  PROBE_RETRY_DELAYS_MS,
  REFRESH_TTL_MS,
  REGISTRY_PROVIDER,
} from './catalog-service'
import type { CatalogModel } from './catalogs'
import { useTempDirs } from './testing/temp-dirs'

const tempDir = useTempDirs()

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
    const probeModels = vi
      .fn()
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

  it('heals a failed round on its own, without waiting for the user', async () => {
    vi.useFakeTimers()
    const onUpdated = vi.fn()
    // First round dropped by the agent (a cold adapter download outlasting its
    // handshake timeout); the retry lands it.
    const probeModels = vi
      .fn()
      .mockRejectedValueOnce(new Error('adapter not cached'))
      .mockResolvedValue([{ id: 'late-landing', label: 'Late landing' }])
    const service = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      probeModels,
      probeKinds: ['codex'],
      onUpdated,
    })
    await service.refresh()
    expect(catalogSource('codex')).not.toBe('live')

    await vi.advanceTimersByTimeAsync(PROBE_RETRY_DELAYS_MS[0])
    expect(probeModels).toHaveBeenCalledTimes(2)
    expect(modelsFor('codex')).toEqual([{ id: 'late-landing', label: 'Late landing' }])
    // The retry published, so an idle composer re-reads without a gesture.
    expect(onUpdated).toHaveBeenCalledTimes(2)
    // Everything landed: the ladder is gone, and no later retry spawns again.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(probeModels).toHaveBeenCalledTimes(2)
  })

  it('stops retrying a kind nobody answers after the bounded ladder', async () => {
    vi.useFakeTimers()
    const probeModels = vi.fn().mockRejectedValue(new Error('adapter not cached'))
    const service = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      probeModels,
      probeKinds: ['codex'],
    })
    await service.refresh()
    let calls = 1
    for (const delay of PROBE_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay)
      calls += 1
      expect(probeModels).toHaveBeenCalledTimes(calls)
    }
    // Ladder exhausted: the timer is not rewound and no further attempts run.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(probeModels).toHaveBeenCalledTimes(calls)
  })

  it('refrains from retrying while a refresh round is in flight', async () => {
    vi.useFakeTimers()
    const gate: { release: (() => void) | null } = { release: null }
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(
        () =>
          new Promise<never>((_resolve, reject) => {
            gate.release = () => reject(new Error('offline'))
          }),
      )
    // Both rounds go unanswered; only the ladder's later retry lands.
    const probeModels = vi
      .fn()
      .mockRejectedValueOnce(new Error('adapter not cached'))
      .mockRejectedValueOnce(new Error('adapter not cached'))
      .mockResolvedValue([{ id: 'from-retry', label: 'From retry' }])
    const service = new CatalogService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      probeModels,
      probeKinds: ['codex'],
    })
    await service.refresh()
    expect(probeModels).toHaveBeenCalledTimes(1)
    // A second round starts (say, a connection rescan). It asks the agent at
    // once, and is still waiting on the registry when the retry comes due.
    const inFlight = service.refresh()
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_DELAYS_MS[0])
    // The in-flight round already asked, so the retry spawned nothing.
    expect(probeModels).toHaveBeenCalledTimes(2)
    gate.release?.()
    await inFlight
    // Its completion restarts the ladder from the first delay.
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_DELAYS_MS[0])
    expect(probeModels).toHaveBeenCalledTimes(3)
    expect(catalogSource('codex')).toBe('live')
  })

  it('retains the live catalog if a later probe fails after a registry refresh', async () => {
    const probeModels = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'future-cli-model', label: 'New CLI model' }])
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
    const service = new CatalogService({
      fetchImpl: vi.fn().mockResolvedValue(
        registryResponse({
          openai: { models: { 'gpt-5.5': { name: 'Old fallback' } } },
        }),
      ) as unknown as typeof fetch,
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
            'claude-x': {
              id: 'claude-x',
              name: 'Claude X',
              limit: { context: 200000 },
              modalities: { output: ['text'] },
            },
            'claude-img': { id: 'claude-img', modalities: { output: ['image'] } },
          },
        },
        openai: { models: { 'gpt-x': { id: 'gpt-x', name: 'GPT X', limit: { context: 400000 } } } },
      }),
    )
    const service = new CatalogService({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await service.refresh()
    expect(modelsFor('claude')).toMatchObject([
      {
        id: 'claude-x',
        label: 'Claude X',
        contextHint: '200k',
        effortsSource: 'fallback',
      },
    ])
    expect(modelsFor('claude')[0]?.efforts?.map((effort) => effort.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(catalogSource('claude')).toBe('cache')
    // grok has no registry payload in this round; its bundled snapshot stays.
    expect(modelsFor('grok')).toEqual(modelsForBefore('grok'))
  })

  it('keeps the snapshot when a round carries no usable Claude rows', async () => {
    const before = modelsForBefore('claude')
    const dir = await tempDir('ari-catalog-')
    const cachePath = join(dir, 'cache', 'models.json')
    const service = new CatalogService({
      fetchImpl: vi.fn().mockResolvedValue(
        registryResponse({
          anthropic: { models: {} },
          openai: { models: { 'gpt-6-astra': { id: 'gpt-6-astra', name: 'GPT-6 Astra' } } },
        }),
      ) as unknown as typeof fetch,
      cachePath,
    })

    await service.refresh()

    // Aliases are additive rows, not a catalog: an anthropic-less round must
    // not overwrite the richer snapshot with three version-less ids.
    expect(modelsFor('claude')).toEqual(before)
    expect(catalogSource('claude')).toBe('snapshot')
    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as {
      providers: Record<string, CatalogModel[]>
    }
    // The round carried no anthropic rows, so it leaves nothing behind for
    // claude: the key stays absent rather than freezing the snapshot.
    expect(cached.providers['anthropic']).toBeUndefined()
    // Rounds that did carry usable rows still apply.
    expect(modelsFor('codex')).toEqual([{ id: 'gpt-6-astra', label: 'GPT-6 Astra' }])
  })

  it('keeps newly released models without an exact-id allowlist and drops deprecated history', async () => {
    const service = new CatalogService({
      fetchImpl: vi.fn().mockResolvedValue(
        registryResponse({
          anthropic: {
            models: {
              'claude-fable-5-1': {
                id: 'claude-fable-5-1',
                name: 'Claude Fable 5.1',
                family: 'claude-fable',
                release_date: '2026-09-01',
              },
              'claude-fable-old': {
                id: 'claude-fable-old',
                family: 'claude-fable',
                release_date: '2024-01-01',
                status: 'deprecated',
              },
            },
          },
          openai: {
            models: {
              'gpt-6-astra': {
                id: 'gpt-6-astra',
                name: 'GPT-6 Astra',
                release_date: '2026-09-04',
                reasoning: true,
                tool_call: true,
              },
              'gpt-realtime-new': { id: 'gpt-realtime-new', release_date: '2026-09-05' },
            },
          },
        }),
      ) as unknown as typeof fetch,
    })

    await service.refresh()

    expect(modelsFor('claude').map((model) => model.id)).toContain('claude-fable-5-1')
    expect(modelsFor('claude').map((model) => model.id)).not.toContain('claude-fable-old')
    expect(modelsFor('codex')).toEqual([{ id: 'gpt-6-astra', label: 'GPT-6 Astra' }])
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
    // Once when the agent's list lands, once when the whole round settles.
    expect(onUpdated).toHaveBeenCalledTimes(2)
    expect(onUpdated).toHaveBeenCalledWith(expect.any(Number))
  })

  it('asks the agents without waiting for the registry fetch', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    const fetchImpl = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          gate.release = () => reject(new Error('offline'))
        }),
    )
    const onUpdated = vi.fn()
    const service = new CatalogService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      probeModels: vi.fn().mockResolvedValue([{ id: 'opus', label: 'Opus 5.5' }]),
      probeKinds: ['claude'],
      onUpdated,
    })
    const round = service.refresh()
    await vi.waitFor(() => expect(catalogSource('claude')).toBe('live'))
    // The picker already heard, while the registry is still out.
    expect(onUpdated).toHaveBeenCalledOnce()
    gate.release?.()
    await round
    expect(modelsFor('claude')).toEqual([{ id: 'opus', label: 'Opus 5.5' }])
  })

  it('saves an agent that answered while another is still being asked', async () => {
    const dir = await tempDir('ari-catalog-')
    const liveCachePath = join(dir, 'agent-catalogs.json')
    const gate: { release: (() => void) | null } = { release: null }
    const service = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      liveCachePath,
      probeModels: vi.fn((kind: DriverKind) =>
        kind === 'claude'
          ? Promise.resolve([{ id: 'opus', label: 'Opus 5.5' }])
          : new Promise<null>((resolve) => {
              gate.release = () => resolve(null)
            }),
      ),
      probeKinds: ['claude', 'hermes'],
    })
    const round = service.refresh()
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(liveCachePath, 'utf8')) as {
        kinds: Record<string, { models: CatalogModel[] }>
      }
      expect(saved.kinds['claude']?.models).toEqual([{ id: 'opus', label: 'Opus 5.5' }])
    })
    gate.release?.()
    await round
  })

  it('opens on what each agent said last run, then asks it again', async () => {
    const dir = await tempDir('ari-catalog-')
    const liveCachePath = join(dir, 'agent-catalogs.json')
    const offline = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    const effort = { currentId: 'high', options: [{ id: 'high', label: 'High' }] }
    const first = new CatalogService({
      fetchImpl: offline,
      liveCachePath,
      probeModels: vi.fn(async () => {
        setDynamicEfforts('claude', effort)
        setAgentDefaultModel('claude', 'opus')
        return [{ id: 'opus', label: 'Opus 5.5' }]
      }),
      probeKinds: ['claude'],
    })
    await first.refresh()
    for (const kind of ALL_KINDS) clearDynamicModels(kind)
    clearDynamicEfforts('claude')
    expect(catalogSource('claude')).not.toBe('live')

    // Next launch: the agent is slow to answer, then fails outright.
    const gate: { fail: (() => void) | null } = { fail: null }
    const probeModels = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          gate.fail = () => reject(new Error('busy'))
        }),
    )
    const onUpdated = vi.fn()
    const second = new CatalogService({
      fetchImpl: offline,
      liveCachePath,
      probeModels,
      probeKinds: ['claude'],
      onUpdated,
    })
    second.start()
    await vi.waitFor(() => expect(probeModels).toHaveBeenCalledOnce())
    expect(catalogSource('claude')).toBe('live')
    expect(modelsFor('claude')).toEqual([{ id: 'opus', label: 'Opus 5.5' }])
    expect(effortsFor('claude')).toEqual(effort)
    expect(agentDefaultModel('claude')).toBe('opus')
    expect(onUpdated).toHaveBeenCalled()
    gate.fail?.()
    await second.ready
    // A failed re-ask leaves last run's answer in place.
    expect(modelsFor('claude')).toEqual([{ id: 'opus', label: 'Opus 5.5' }])
  })

  it('does not ask again when the cached catalog came from the same CLI version', async () => {
    const dir = await tempDir('ari-catalog-')
    const liveCachePath = join(dir, 'agent-catalogs.json')
    const offline = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    const cliVersion = vi.fn(async () => '1.2.3')
    const first = new CatalogService({
      fetchImpl: offline,
      liveCachePath,
      cliVersion,
      probeModels: vi.fn(async () => [{ id: 'opus', label: 'Opus 5.5' }]),
      probeKinds: ['claude'],
    })
    await first.refresh()
    for (const kind of ALL_KINDS) clearDynamicModels(kind)
    expect(catalogSource('claude')).not.toBe('live')

    const probeModels = vi.fn(async () => [{ id: 'opus', label: 'Opus 5.5' }])
    const second = new CatalogService({
      fetchImpl: offline,
      liveCachePath,
      cliVersion,
      probeModels,
      probeKinds: ['claude'],
    })
    second.start()
    await second.ready

    expect(catalogSource('claude')).toBe('live')
    expect(probeModels).not.toHaveBeenCalled()
  })

  it('asks again when the cached catalog came from another Ari build', async () => {
    const dir = await tempDir('ari-catalog-')
    const liveCachePath = join(dir, 'agent-catalogs.json')
    const offline = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
    const cliVersion = vi.fn(async () => '1.2.3')
    const first = new CatalogService({
      fetchImpl: offline,
      liveCachePath,
      cliVersion,
      appVersion: '0.3.7',
      probeModels: vi.fn(async () => [{ id: 'opus', label: 'Opus 5.5' }]),
      probeKinds: ['claude'],
    })
    await first.refresh()
    for (const kind of ALL_KINDS) clearDynamicModels(kind)

    const probeModels = vi.fn(async () => [{ id: 'opus', label: 'Opus 5.6' }])
    const second = new CatalogService({
      fetchImpl: offline,
      liveCachePath,
      cliVersion,
      appVersion: '0.3.8',
      probeModels,
      probeKinds: ['claude'],
    })
    second.start()
    await second.ready

    expect(probeModels).toHaveBeenCalledTimes(1)
    expect(modelsFor('claude')).toEqual([{ id: 'opus', label: 'Opus 5.6' }])
  })

  it('persists a successful round to the disk cache and reloads it cold', async () => {
    const dir = await tempDir('ari-catalog-')
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
    // `family` rides along: a cold start with no network has only this cache
    // to collapse pointers with. A model the registry gives no family is its
    // own family, which is why it defaults to the id.
    expect(cached.providers['anthropic']).toEqual([
      { id: 'claude-disk', label: 'Disk Model', family: 'claude-disk' },
    ])

    // Cold start with a dead network must restore the cached catalogs.
    const second = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      cachePath,
    })
    second.start()
    await second.ready
    expect(modelsFor('claude')).toMatchObject([
      { id: 'claude-disk', label: 'Disk Model', effortsSource: 'fallback' },
    ])
    expect(second.lastRefreshAt).toBe(cached.at)
  })

  it('never persists live probe output as registry data', async () => {
    const dir = await tempDir('ari-catalog-')
    const cachePath = join(dir, 'cache', 'models.json')
    const service = new CatalogService({
      fetchImpl: vi.fn().mockResolvedValue(
        registryResponse({
          openai: { models: { 'gpt-vendor': { id: 'gpt-vendor', name: 'Vendor GPT' } } },
        }),
      ) as unknown as typeof fetch,
      cachePath,
      probeModels: vi.fn().mockResolvedValue([{ id: 'probe-only', label: 'From the harness' }]),
      probeKinds: ['codex'],
    })

    await service.refresh()
    // Second round rewrites the cache while the live probe result is the
    // active catalog — the write must not pick that up.
    await service.refresh()
    expect(catalogSource('codex')).toBe('live')

    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as {
      providers: Record<string, CatalogModel[]>
    }
    // The cache is models.dev's answer. Replaying a harness's own model list
    // as vendor data let a probe from one session outlive it as `cache`.
    expect(cached.providers['openai']?.map((model) => model.id)).toEqual(['gpt-vendor'])
  })

  it('writes only the providers a round actually carried', async () => {
    const dir = await tempDir('ari-catalog-')
    const cachePath = join(dir, 'cache', 'models.json')
    const service = new CatalogService({
      fetchImpl: vi.fn().mockResolvedValue(
        registryResponse({
          anthropic: { models: {} },
          openai: { models: { 'gpt-6-astra': { id: 'gpt-6-astra', name: 'GPT-6 Astra' } } },
        }),
      ) as unknown as typeof fetch,
      cachePath,
    })

    await service.refresh()

    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as {
      providers: Record<string, CatalogModel[]>
    }
    // An anthropic-less round must leave the key absent rather than freezing
    // whatever the picker happened to be serving (snapshot or probe output).
    expect(cached.providers['anthropic']).toBeUndefined()
    expect(cached.providers['openai']?.map((model) => model.id)).toEqual(['gpt-6-astra'])
  })

  it('does not re-probe a kind that already told us its own models', async () => {
    vi.useFakeTimers()
    const probeModels = vi.fn().mockResolvedValue([{ id: 'live-model', label: 'Live' }])
    const service = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      probeModels,
      probeKinds: ['codex'],
    })
    await service.refresh()
    expect(probeModels).toHaveBeenCalledTimes(1)

    // Well past the 60s retry throttle, but a live catalog is the agent's own
    // word for a vocabulary that belongs to the installed CLI. Re-asking on
    // every picker open spawned an agent process per kind per minute to learn
    // the same list again.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await service.refresh()
    expect(probeModels).toHaveBeenCalledTimes(1)

    // Past the window, ask again: an upgraded CLI can advertise new models.
    await vi.advanceTimersByTimeAsync(REFRESH_TTL_MS)
    await service.refresh()
    expect(probeModels).toHaveBeenCalledTimes(2)
  })

  it('re-probes as soon as the installed CLI reports a new version', async () => {
    vi.useFakeTimers()
    let version = '2.1.232'
    const probeModels = vi.fn().mockResolvedValue([{ id: 'live-model', label: 'Live' }])
    const service = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      probeModels,
      probeKinds: ['claude'],
      cliVersion: async () => version,
    })
    await service.refresh()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await service.refresh()
    expect(probeModels).toHaveBeenCalledTimes(1)

    // The CLI updated itself while Ari stayed open: its vocabulary may have
    // grown, so the live-catalog window no longer applies.
    version = '2.1.296'
    await service.refresh()
    expect(probeModels).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    await service.refresh()
    expect(probeModels).toHaveBeenCalledTimes(2)
  })

  it('keeps asking after a version change until a probe lands', async () => {
    vi.useFakeTimers()
    let version = '1.0.0'
    const probeModels = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'old-model', label: 'Old' }])
      .mockRejectedValueOnce(new Error('cli busy updating'))
      .mockResolvedValue([{ id: 'new-model', label: 'New' }])
    const service = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      probeModels,
      probeKinds: ['claude'],
      cliVersion: async () => version,
    })
    await service.refresh()
    version = '1.1.0'
    await service.refresh()
    await service.refresh()
    expect(probeModels).toHaveBeenCalledTimes(3)
    expect(modelsFor('claude')).toEqual([{ id: 'new-model', label: 'New' }])
  })

  it('adopts a live catalog it did not probe without re-asking the agent', async () => {
    vi.useFakeTimers()
    const probeModels = vi.fn().mockResolvedValue([{ id: 'probed', label: 'Probed' }])
    const service = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      probeModels,
      probeKinds: ['claude'],
      cliVersion: async () => '2.1.296',
    })
    // A session's agent published its list before any probe ran.
    setDynamicModels('claude', 'live', [{ id: 'from-session', label: 'From session' }])
    await service.refresh()
    expect(probeModels).not.toHaveBeenCalled()
  })

  it('keeps re-probing a kind that never managed to report', async () => {
    vi.useFakeTimers()
    const probeModels = vi.fn().mockRejectedValue(new Error('adapter not cached'))
    const service = new CatalogService({
      fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      probeModels,
      probeKinds: ['codex'],
    })
    await service.refresh()
    expect(probeModels).toHaveBeenCalledTimes(1)

    // The ladder re-asks on its own — a kind still on the snapshot after a
    // failed round is not left waiting for the user to do anything.
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_DELAYS_MS[0])
    expect(probeModels).toHaveBeenCalledTimes(2)

    // A natural round after the 60s throttle re-asks too: the live-catalog
    // window must not hold a kind that never answered back.
    await vi.advanceTimersByTimeAsync(60_000)
    await service.refresh()
    expect(probeModels).toHaveBeenCalledTimes(3)
  })

  it('shares one in-flight refresh across concurrent callers', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(registryResponse({ anthropic: { models: {} } })), 20),
          ),
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
