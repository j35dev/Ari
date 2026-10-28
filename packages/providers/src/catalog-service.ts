import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DriverKind } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import {
  catalogSetAt,
  catalogSource,
  liveCatalogOf,
  restoreLiveCatalog,
  setDynamicModels,
} from './catalogs'
import type { CatalogModel, LiveCatalog } from './catalogs'

const log = createLogger('providers:catalog')

/**
 * models.dev provider id backing each CLI kind's registry data. Kinds that
 * route through their own provider configs (opencode/pi/hermes) are absent:
 * their catalogs come from ACP model probes or the `CLI default` fallback.
 */
export const REGISTRY_PROVIDER: Partial<Record<DriverKind, string>> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
}

/** Default upstream registry (the open dataset behind opencode/T3-style clients). */
export const DEFAULT_REGISTRY_URL = 'https://models.dev/api.json'

/** How long a fetched registry payload stays fresh. */
export const REFRESH_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Escalating gaps between self-scheduled probe retries. A round the agent
 * failed to answer (a cold npx cache, a busy CLI) must not leave its pickers
 * waiting for the user to do anything: the service re-asks itself a few times,
 * then stops and retries on the next natural round instead.
 */
export const PROBE_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const

/**
 * How long an agent's own model list is trusted before it is worth asking
 * again. Deliberately far longer than the retry throttle: re-probing spawns
 * the CLI to hear a vocabulary that only changes when the CLI is upgraded.
 */
export const LIVE_RECHECK_MS = 6 * 60 * 60 * 1000

interface RegistryModel {
  id?: string
  name?: string
  family?: string
  release_date?: string
  status?: string
  reasoning?: boolean
  tool_call?: boolean
  modalities?: { output?: string[] }
  limit?: { context?: number }
}

interface RegistryPayload {
  [providerId: string]: { models?: Record<string, RegistryModel> } | undefined
}

interface DiskCache {
  at: number
  url: string
  providers: Record<string, CatalogModel[]>
}

interface LiveDiskCache {
  at: number
  kinds: Partial<Record<DriverKind, LiveCatalog>>
  /** The CLI each live catalog was read from, when the host can tell. */
  versions?: Partial<Record<DriverKind, string | null>>
}

export interface ModelProbe {
  /** Probes the provider itself for its model list; null/throw means unavailable. */
  (kind: DriverKind): Promise<CatalogModel[] | null>
}

export interface CatalogServiceOptions {
  fetchImpl?: typeof fetch
  registryUrl?: string
  cachePath?: string
  /**
   * Where the agents' own catalogs are kept between runs. Restored before the
   * first read, so pickers open on what each agent said last time instead of
   * a registry guess while it is asked again.
   */
  liveCachePath?: string
  ttlMs?: number
  /**
   * Optional live probe (ACP session config options). When provided it runs
   * after the registry merge and overrides with the agent's own model list.
   */
  probeModels?: ModelProbe
  /** Kinds the probe is allowed to run for; empty disables probing. */
  probeKinds?: DriverKind[]
  /**
   * The installed CLI's version for a kind, or null when unknown. A live
   * catalog is trusted only while this stays the same: a CLI that updates
   * itself can serve new models long before the recheck window runs out.
   */
  cliVersion?: (kind: DriverKind) => Promise<string | null>
  /** Called after registry refresh and live ACP probes have settled. */
  onUpdated?: (at: number) => void
}

interface RegistryCandidate {
  catalog: CatalogModel
  family: string
  releasedAt: number
}

function toCatalogModels(kind: DriverKind, models: Record<string, RegistryModel>): CatalogModel[] {
  const candidates: RegistryCandidate[] = []
  for (const [id, model] of Object.entries(models)) {
    const outputs = model.modalities?.output
    if (outputs && !outputs.includes('text')) continue
    if (model.id && model.id !== id) continue
    if (model.status === 'deprecated') continue
    const context = model.limit?.context
    candidates.push({
      catalog: {
        id,
        label: typeof model.name === 'string' && model.name.length > 0 ? model.name : id,
        // Carried so the picker can tell a version-less pointer from a real
        // sibling (`gpt-5.6` vs `gpt-5.6-sol`), which names alone cannot.
        family: model.family ?? id,
        ...(context !== undefined && context > 0
          ? { contextHint: `${Math.round(context / 1000)}k` }
          : {}),
      },
      family: model.family ?? id,
      releasedAt: typeof model.release_date === 'string' ? Date.parse(model.release_date) || 0 : 0,
    })
  }
  candidates.sort((a, b) => b.releasedAt - a.releasedAt)

  if (kind === 'claude') {
    const perFamily = new Map<string, number>()
    const current = candidates
      .filter((candidate) => {
        if (!candidate.catalog.id.startsWith('claude-')) return false
        const count = perFamily.get(candidate.family) ?? 0
        if (count >= 2) return false
        perFamily.set(candidate.family, count + 1)
        return true
      })
      .slice(0, 12)
    // Rows only: version-less family ids ride as aliases on the newest member
    // (see collapseCatalog). An anthropic-less round still yields [] so the
    // caller keeps the richer snapshot rather than an empty picker.
    return current.map((candidate) => candidate.catalog)
  }

  if (kind === 'codex') {
    return candidates
      .filter((candidate) => {
        const id = candidate.catalog.id
        if (!id.startsWith('gpt-')) return false
        if (/(?:audio|chat|image|realtime|transcrib|tts)/i.test(id)) return false
        const model = models[id]
        return model?.reasoning !== false && model?.tool_call !== false
      })
      .slice(0, 12)
      .map((candidate) => candidate.catalog)
  }

  return candidates.slice(0, 12).map((candidate) => candidate.catalog)
}

/**
 * Keeps driver model catalogs current: bundled snapshot → disk-cached
 * registry refresh → live fetch → optional per-agent probes. Every step is
 * fail-soft; {@link modelsFor} always has data to serve synchronously.
 */
export class CatalogService {
  readonly #fetchImpl: typeof fetch
  readonly #registryUrl: string
  readonly #cachePath: string | null
  readonly #liveCachePath: string | null
  /** Kinds serving a catalog restored from disk that no probe has confirmed yet. */
  readonly #unconfirmed = new Set<DriverKind>()
  #liveWrite: Promise<void> = Promise.resolve()
  readonly #ttlMs: number
  readonly #probeModels: ModelProbe | null
  readonly #probeKinds: DriverKind[]
  readonly #cliVersion: ((kind: DriverKind) => Promise<string | null>) | null
  /** The CLI version each kind's live catalog was read from. */
  readonly #liveVersions = new Map<DriverKind, string | null>()
  readonly #onUpdated: ((at: number) => void) | null
  #lastRefreshAt = 0
  #lastAttemptAt: number | null = null
  #refreshing: Promise<void> | null = null
  #boot: Promise<void> | null = null
  /** Retries scheduled for kinds a round could not get an answer from. */
  #probeRetryTimer: ReturnType<typeof setTimeout> | null = null
  #probeRetryAttempts = 0

  constructor(options: CatalogServiceOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#registryUrl = options.registryUrl ?? process.env['ARI_MODELS_URL'] ?? DEFAULT_REGISTRY_URL
    this.#cachePath = options.cachePath ?? null
    this.#liveCachePath = options.liveCachePath ?? null
    this.#ttlMs = options.ttlMs ?? REFRESH_TTL_MS
    this.#probeModels = options.probeModels ?? null
    this.#probeKinds = options.probeKinds ?? []
    this.#cliVersion = options.cliVersion ?? null
    this.#onUpdated = options.onUpdated ?? null
  }

  /**
   * Synchronously usable immediately: installs the snapshot-backed catalogs
   * and kicks a background disk-cache load + network refresh.
   */
  start(): void {
    void this.ready
  }

  /** Resolves once the initial disk-cache load + refresh round completes. */
  get ready(): Promise<void> {
    this.#boot ??= (async () => {
      await Promise.all([this.#loadLiveCache(), this.#loadDiskCache()])
      await this.refresh()
    })()
    return this.#boot
  }

  /** True once a successful refresh (disk or network) has been applied. */
  get lastRefreshAt(): number {
    return this.#lastRefreshAt
  }

  /**
   * Fetches the registry and installs fresh catalogs (`cache` source), then
   * runs any configured live probes (`live` source wins). Concurrent calls
   * share one in-flight refresh.
   */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#lastAttemptAt = Date.now()
      this.#refreshing = null
    })
    return this.#refreshing
  }

  /** Rechecks catalogs on demand, throttling failed probes as well as successful ones. */
  refreshIfStale(): Promise<void> {
    if (this.#refreshing !== null) return this.#refreshing
    if (this.#lastAttemptAt !== null && Date.now() - this.#lastAttemptAt < 60_000) {
      return Promise.resolve()
    }
    return this.refresh()
  }

  async #refresh(): Promise<void> {
    // A fresh round asks every not-yet-live kind again, so its completion both
    // supersedes any pending retry and restarts the retry ladder.
    this.#probeRetryAttempts = 0
    // The agents are asked alongside the registry, not after it: a probe is
    // the slow half, and waiting on a network fetch first only delayed it.
    await Promise.all([this.#refreshRegistry(), this.#runProbes()])
    this.#scheduleProbeRetry()
    // Even a round whose probes failed publishes: the composer's first empty
    // catalog read must be invalidated once the handshakes that would answer
    // it have settled, whatever their verdict.
    this.#onUpdated?.(Date.now())
  }

  async #refreshRegistry(): Promise<void> {
    try {
      const response = await this.#fetchImpl(this.#registryUrl, {
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as RegistryPayload
      // What this round actually got from the registry, kept separately from
      // the dynamic overlay: the disk cache must hold the registry's answer,
      // never the merged catalog the picker is currently serving.
      const derived = new Map<DriverKind, CatalogModel[]>()
      for (const [kind, providerId] of Object.entries(REGISTRY_PROVIDER)) {
        const models = toCatalogModels(kind as DriverKind, body[providerId]?.models ?? {})
        if (models.length === 0) continue
        derived.set(kind as DriverKind, models)
        if (catalogSource(kind as DriverKind) !== 'live') {
          setDynamicModels(kind as DriverKind, 'cache', models)
        }
      }
      this.#lastRefreshAt = Date.now()
      log.info('registry catalog refreshed', { providers: derived.size, url: this.#registryUrl })
      await this.#writeDiskCache({
        at: Date.now(),
        url: this.#registryUrl,
        providers: Object.fromEntries(
          [...derived].map(([kind, models]) => [REGISTRY_PROVIDER[kind] as string, models]),
        ),
      })
    } catch (error) {
      // Offline is routine (first boot without network): the snapshot and any
      // stale disk cache keep pickers populated until a later round lands.
      log.debug('registry refresh failed (snapshot stays active)', { error: String(error) })
    }
  }

  /** True when a kind adopted a live catalog it did not have before. */
  async #runProbes(): Promise<boolean> {
    if (this.#probeModels === null || this.#probeKinds.length === 0) return false
    let adopted = false
    await Promise.all(
      this.#probeKinds.map(async (kind) => {
        // A live catalog is the agent's own word, and the vocabulary belongs to
        // the installed CLI rather than to the moment. Re-probing spawns that
        // agent again to hear the same list, so a kind that has already
        // answered waits out the window; one still on a fallback has
        // everything to gain from a retry and is never held back.
        const version = await this.#versionOf(kind)
        if (this.#probeIsFresh(kind, version)) return
        try {
          const models = await this.#probeModels!(kind)
          if (models !== null && models.length > 0) {
            setDynamicModels(kind, 'live', models)
            this.#liveVersions.set(kind, version)
            this.#unconfirmed.delete(kind)
            adopted = true
            log.info('live model probe applied', { kind, count: models.length })
            // Each agent lands on its own: Claude's list must not wait for the
            // slowest of six handshakes before the picker hears about it, nor
            // before it is saved — a quit mid-round would lose it otherwise.
            this.#onUpdated?.(Date.now())
            await this.#writeLiveCache()
          }
        } catch (error) {
          log.debug('live model probe failed', { kind, error: String(error) })
        }
      }),
    )
    return adopted
  }

  /**
   * Sets the timer for kinds a round could not get an answer from. Without
   * this a failed handshake (a freshly bumped adapter downloading into npx
   * slower than its own timeout) leaves model and effort pickers empty until
   * some other round happens to run — and nothing schedules one while the app
   * idles, which is how a chip can sit missing for a whole session.
   */
  #scheduleProbeRetry(): void {
    if (this.#probeRetryTimer !== null) {
      clearTimeout(this.#probeRetryTimer)
      this.#probeRetryTimer = null
    }
    if (this.#probeModels === null) return
    const pending = this.#probeKinds.filter((kind) => catalogSource(kind) !== 'live')
    if (pending.length === 0) return
    if (this.#probeRetryAttempts >= PROBE_RETRY_DELAYS_MS.length) return
    const delay = PROBE_RETRY_DELAYS_MS[this.#probeRetryAttempts] ?? PROBE_RETRY_DELAYS_MS[0]
    this.#probeRetryTimer = setTimeout(() => void this.#runProbeRetry(), delay)
  }

  async #runProbeRetry(): Promise<void> {
    this.#probeRetryTimer = null
    // An in-flight round asks every kind itself; racing it would double the
    // spawns, and its completion reschedules from the first delay.
    if (this.#refreshing !== null) return
    this.#probeRetryAttempts += 1
    // Probes only: registry data cannot have moved within a retry window, and
    // a registry fetch that failed would only stretch the wait. A kind answered
    // by an earlier attempt waits out the live-catalog window, so a retry only
    // re-asks what is still silent.
    // A landing publishes from inside the round, so an idle composer re-reads
    // without a user gesture; a still-failing kind advances the ladder below.
    await this.#runProbes()
    this.#scheduleProbeRetry()
  }

  #probeIsFresh(kind: DriverKind, version: string | null): boolean {
    if (catalogSource(kind) !== 'live' || this.#unconfirmed.has(kind)) return false
    const at = catalogSetAt(kind)
    if (at === null || Date.now() - at >= LIVE_RECHECK_MS) return false
    // A list a session's agent published came from the CLI installed now.
    if (!this.#liveVersions.has(kind)) this.#liveVersions.set(kind, version)
    return this.#liveVersions.get(kind) === version
  }

  async #versionOf(kind: DriverKind): Promise<string | null> {
    if (this.#cliVersion === null) return null
    try {
      return await this.#cliVersion(kind)
    } catch (error) {
      log.debug('cli version lookup failed', { kind, error: String(error) })
      return null
    }
  }

  async #loadLiveCache(): Promise<void> {
    if (this.#liveCachePath === null) return
    let raw: LiveDiskCache
    try {
      raw = JSON.parse(await readFile(this.#liveCachePath, 'utf8')) as LiveDiskCache
    } catch {
      return // First run: nothing saved yet, the round below asks.
    }
    let restored = 0
    for (const [name, catalog] of Object.entries(raw.kinds ?? {})) {
      if (!Array.isArray(catalog?.models) || catalog.models.length === 0) continue
      // A kind a session already answered for this run keeps its fresher list.
      const kind = name as DriverKind
      if (catalogSource(kind) === 'live') continue
      restoreLiveCatalog(kind, {
        models: catalog.models,
        efforts: catalog.efforts ?? { currentId: null, options: [] },
        modes: catalog.modes ?? { currentId: null, options: [] },
        defaultModelId: catalog.defaultModelId ?? null,
      })
      // A saved version lets the first round skip a probe that would only
      // repeat what the same CLI already said; without one, confirm it.
      if (raw.versions !== undefined && Object.prototype.hasOwnProperty.call(raw.versions, kind)) {
        this.#liveVersions.set(kind, raw.versions[kind] ?? null)
      } else {
        this.#unconfirmed.add(kind)
      }
      restored += 1
    }
    if (restored === 0) return
    log.info('agent catalogs restored from disk', { kinds: restored })
    // The composer may have read before the file did; tell it to read again.
    this.#onUpdated?.(Date.now())
  }

  /** Saves the agents' catalogs; writes queue so two landings never interleave. */
  #writeLiveCache(): Promise<void> {
    this.#liveWrite = this.#liveWrite.then(() => this.#saveLiveCache())
    return this.#liveWrite
  }

  async #saveLiveCache(): Promise<void> {
    if (this.#liveCachePath === null) return
    const kinds: Partial<Record<DriverKind, LiveCatalog>> = {}
    for (const kind of this.#probeKinds) {
      const catalog = liveCatalogOf(kind)
      if (catalog !== null) kinds[kind] = catalog
    }
    const versions: Partial<Record<DriverKind, string | null>> | undefined =
      this.#cliVersion === null ? undefined : Object.fromEntries(this.#liveVersions)
    try {
      await mkdir(dirname(this.#liveCachePath), { recursive: true })
      await writeFile(
        this.#liveCachePath,
        JSON.stringify({
          at: Date.now(),
          kinds,
          ...(versions === undefined ? {} : { versions }),
        } satisfies LiveDiskCache),
        'utf8',
      )
    } catch (error) {
      log.debug('live catalog cache write failed', { error: String(error) })
    }
  }

  async #loadDiskCache(): Promise<void> {
    if (this.#cachePath === null || this.lastRefreshAt > 0) return
    try {
      const raw = JSON.parse(await readFile(this.#cachePath, 'utf8')) as DiskCache
      if (raw.url !== this.#registryUrl) return
      for (const [kind, providerId] of Object.entries(REGISTRY_PROVIDER)) {
        const models = raw.providers[providerId]
        // The agents' own lists load alongside; the registry never covers one.
        if (
          Array.isArray(models) &&
          models.length > 0 &&
          catalogSource(kind as DriverKind) !== 'live'
        ) {
          setDynamicModels(kind as DriverKind, 'cache', models)
        }
      }
      this.#lastRefreshAt = raw.at
      // Stale cache still beats nothing while the network round runs.
      if (Date.now() - raw.at > this.#ttlMs) void this.refresh()
    } catch {
      // No cache yet — the snapshot covers the picker until first success.
    }
  }

  async #writeDiskCache(cache: DiskCache): Promise<void> {
    if (this.#cachePath === null) return
    try {
      await mkdir(dirname(this.#cachePath), { recursive: true })
      await writeFile(this.#cachePath, JSON.stringify(cache), 'utf8')
    } catch (error) {
      log.debug('catalog cache write failed', { error: String(error) })
    }
  }
}
