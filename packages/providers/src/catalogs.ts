import type { DriverKind } from '@ari/contracts/common'
import snapshot from './catalog-snapshot.json'

/** One curated model entry for a driver's picker. */
export interface CatalogModel {
  id: string
  label: string
  /** Short context-window hint rendered beside the label, e.g. `200k`. */
  contextHint?: string
}

/** Where the current catalog for a kind came from. */
export type CatalogSource = 'live' | 'cache' | 'snapshot' | 'static'

const CLI_DEFAULT_MODELS: CatalogModel[] = [{ id: 'default', label: 'CLI default' }]

/**
 * Last-resort static catalogs (M4.14). Used only when neither a live refresh
 * nor the bundled snapshot has data for a kind; `ari-core` stays empty
 * because its endpoints supply their own models at session-create time.
 */
export const MODEL_CATALOGS: Record<DriverKind, CatalogModel[]> = {
  claude: CLI_DEFAULT_MODELS,
  codex: CLI_DEFAULT_MODELS,
  opencode: CLI_DEFAULT_MODELS,
  grok: CLI_DEFAULT_MODELS,
  pi: CLI_DEFAULT_MODELS,
  hermes: CLI_DEFAULT_MODELS,
  'ari-core': [],
}

/**
 * models.dev provider id backing each kind's bundled snapshot fallback.
 * Kinds without an entry (opencode/pi/hermes route through their own
 * provider configs) fall through to `CLI default` until a live source or
 * an ACP session reports real models.
 */
const SNAPSHOT_PROVIDER: Partial<Record<DriverKind, string>> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
}

const SNAPSHOT = snapshot as {
  generatedAt: number
  sourceUrl: string
  providers: Record<string, CatalogModel[]>
}

/**
 * Dynamic overlay populated by the main-process CatalogService (models.dev
 * refreshes + ACP model probes). Renderer-safe: the module is pure until a
 * host process calls {@link setDynamicModels}.
 */
const dynamic = new Map<DriverKind, { source: CatalogSource; models: CatalogModel[] }>()

/** Installs a freshly-fetched catalog for a kind, replacing any previous one. */
export function setDynamicModels(kind: DriverKind, source: CatalogSource, models: CatalogModel[]): void {
  if (models.length === 0) return
  dynamic.set(kind, { source, models })
}

/** Removes any dynamic overlay for a kind (tests, invalidation). */
export function clearDynamicModels(kind: DriverKind): void {
  dynamic.delete(kind)
}

/** Where {@link modelsFor} data currently comes from for a kind. */
export function catalogSource(kind: DriverKind): CatalogSource {
  return dynamic.get(kind)?.source ?? (snapshotFor(kind) !== null ? 'snapshot' : 'static')
}

/**
 * models.dev lists every model a vendor ever shipped; each CLI only serves a
 * handful. These exact ids (cross-checked against each harness's own catalog:
 * Codex's bundled models.json visible set, claude-code-acp's supportedModels
 * response) keep the picker to what the harness actually accepts today.
 *
 * simplification: static curation, not a per-CLI capability probe. A live ACP
 * probe (source `live`) always wins over this, so the ceiling only applies to
 * the snapshot fallback. Upgrade path: none needed while probes cover the
 * major harnesses; re-curate when vendors ship new models.
 */
const CURRENT_MODEL_IDS: Partial<Record<DriverKind, string[]>> = {
  claude: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-6'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  grok: ['grok-4.6', 'grok-4.5', 'grok-build-0.1'],
}

function snapshotFor(kind: DriverKind): CatalogModel[] | null {
  const providerId = SNAPSHOT_PROVIDER[kind]
  const models = providerId !== undefined ? (SNAPSHOT.providers[providerId] ?? null) : null
  if (models === null || models.length === 0) return null
  const currentIds = CURRENT_MODEL_IDS[kind]
  if (currentIds === undefined) return models
  const current = models.filter((model) => currentIds.includes(model.id))
  // Never return an empty list because a curated id went stale: a picker with
  // the full vendor catalog beats a picker with nothing in it.
  return current.length > 0 ? current : models
}

/**
 * Model catalog entries for a driver's picker, merged in priority order:
 * live provider data → cached refresh → bundled snapshot → static defaults.
 * Synchronous and renderer-safe; dynamic overlays arrive via
 * {@link setDynamicModels} in the main process.
 */
export function modelsFor(kind: DriverKind): CatalogModel[] {
  return dynamic.get(kind)?.models ?? snapshotFor(kind) ?? MODEL_CATALOGS[kind]
}
