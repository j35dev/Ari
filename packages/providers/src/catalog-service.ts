import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DriverKind } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { catalogSource, modelsFor, setDynamicModels } from './catalogs'
import type { CatalogModel } from './catalogs'

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

interface RegistryModel {
  id?: string
  name?: string
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

export interface ModelProbe {
  /** Probes the provider itself for its model list; null/throw means unavailable. */
  (kind: DriverKind): Promise<CatalogModel[] | null>
}

export interface CatalogServiceOptions {
  fetchImpl?: typeof fetch
  registryUrl?: string
  cachePath?: string
  ttlMs?: number
  /**
   * Optional live probe (ACP session config options). When provided it runs
   * after the registry merge and overrides with the agent's own model list.
   */
  probeModels?: ModelProbe
  /** Kinds the probe is allowed to run for; empty disables probing. */
  probeKinds?: DriverKind[]
  /** Called after registry refresh and live ACP probes have settled. */
  onUpdated?: (at: number) => void
}

function toCatalogModels(models: Record<string, RegistryModel>): CatalogModel[] {
  const out: CatalogModel[] = []
  for (const [id, model] of Object.entries(models)) {
    const outputs = model.modalities?.output
    if (outputs && !outputs.includes('text')) continue
    if (model.id && model.id !== id) continue
    const context = model.limit?.context
    out.push({
      id,
      label: typeof model.name === 'string' && model.name.length > 0 ? model.name : id,
      ...(context !== undefined && context > 0 ? { contextHint: `${Math.round(context / 1000)}k` } : {}),
    })
  }
  return out
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
  readonly #ttlMs: number
  readonly #probeModels: ModelProbe | null
  readonly #probeKinds: DriverKind[]
  readonly #onUpdated: ((at: number) => void) | null
  #lastRefreshAt = 0
  #lastAttemptAt: number | null = null
  #refreshing: Promise<void> | null = null
  #boot: Promise<void> | null = null

  constructor(options: CatalogServiceOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#registryUrl = options.registryUrl ?? process.env['ARI_MODELS_URL'] ?? DEFAULT_REGISTRY_URL
    this.#cachePath = options.cachePath ?? null
    this.#ttlMs = options.ttlMs ?? REFRESH_TTL_MS
    this.#probeModels = options.probeModels ?? null
    this.#probeKinds = options.probeKinds ?? []
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
      await this.#loadDiskCache()
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
    try {
      const response = await this.#fetchImpl(this.#registryUrl, {
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as RegistryPayload
      let applied = 0
      for (const [kind, providerId] of Object.entries(REGISTRY_PROVIDER)) {
        const models = toCatalogModels(body[providerId]?.models ?? {})
        if (models.length === 0) continue
        if (catalogSource(kind as DriverKind) !== 'live') {
          setDynamicModels(kind as DriverKind, 'cache', models)
        }
        applied++
      }
      this.#lastRefreshAt = Date.now()
      log.info('registry catalog refreshed', { providers: applied, url: this.#registryUrl })
      await this.#writeDiskCache({
        at: Date.now(),
        url: this.#registryUrl,
        providers: Object.fromEntries(
          Object.entries(REGISTRY_PROVIDER).map(([kind, providerId]) => [
            providerId,
            modelsFor(kind as DriverKind),
          ]),
        ),
      })
    } catch (error) {
      // Offline is routine (first boot without network): the snapshot and any
      // stale disk cache keep pickers populated until a later round lands.
      log.debug('registry refresh failed (snapshot stays active)', { error: String(error) })
    }
    await this.#runProbes()
    this.#onUpdated?.(Date.now())
  }

  async #runProbes(): Promise<void> {
    if (this.#probeModels === null || this.#probeKinds.length === 0) return
    await Promise.all(
      this.#probeKinds.map(async (kind) => {
        try {
          const models = await this.#probeModels!(kind)
          if (models !== null && models.length > 0) {
            setDynamicModels(kind, 'live', models)
            log.info('live model probe applied', { kind, count: models.length })
          }
        } catch (error) {
          log.debug('live model probe failed', { kind, error: String(error) })
        }
      }),
    )
  }

  async #loadDiskCache(): Promise<void> {
    if (this.#cachePath === null || this.lastRefreshAt > 0) return
    try {
      const raw = JSON.parse(await readFile(this.#cachePath, 'utf8')) as DiskCache
      if (raw.url !== this.#registryUrl) return
      for (const [kind, providerId] of Object.entries(REGISTRY_PROVIDER)) {
        const models = raw.providers[providerId]
        if (Array.isArray(models) && models.length > 0) {
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
