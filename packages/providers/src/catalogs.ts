import type { DriverKind } from '@ari/contracts/common'
import snapshot from './catalog-snapshot.json'
import type { CatalogEffort, EffortCatalog } from './acp/thought'
import type { AgentModeCatalog } from './acp/modes'

export type { CatalogEffort, EffortCatalog } from './acp/thought'
export type { CatalogAgentMode, AgentModeCatalog } from './acp/modes'

/** One curated model entry for a driver's picker. */
export interface CatalogModel {
  id: string
  label: string
  /** Short context-window hint rendered beside the label, e.g. `200k`. */
  contextHint?: string
  /** One-line summary in the agent's own words, shown under the label. */
  description?: string
  /**
   * Other ids that resolve to this same model. Carries the version-less
   * family pointers a CLI accepts (`opus` for `claude-opus-5`) and the ids of
   * rows folded away as duplicate display names, so a session saved against
   * any of them still finds this row.
   */
  aliases?: string[]
  /** Superseded by a newer model in its family; the picker collapses these. */
  isLegacy?: boolean
  /**
   * Vendor family grouping (`claude-opus`, `gpt-sol`), as the registry reports
   * it. Rows that share one are the same model line, which is what lets
   * {@link collapseCatalog} tell a version-less pointer from a real sibling.
   * Absent on catalogs that predate it; those fall back to id prefixes.
   */
  family?: string
  /**
   * Thought/reasoning levels this model accepts, when the source knows them.
   * A live probe or Codex's own model list fills these; a static table marks
   * them `fallback` so the picker still refines against the agent.
   */
  efforts?: CatalogEffort[]
  /** Where `efforts` came from. `fallback` is provisional until the agent answers. */
  effortsSource?: 'agent' | 'fallback'
}

/** Where the current catalog for a kind came from. */
export type CatalogSource = 'live' | 'cache' | 'snapshot' | 'static'

const CLI_DEFAULT_MODELS: CatalogModel[] = [{ id: 'default', label: 'CLI default' }]

/**
 * Id prefixes that name a model family, mapped to the version-less id the CLI
 * resolves to that family's newest member. These are not separate choices — a
 * user picking "Opus (latest)" and one picking "Claude Opus 5" mean the same
 * model — so they ride as {@link CatalogModel.aliases} on the family's newest
 * row instead of appearing as rows of their own, which is what put
 * "Fable (latest)" directly above "Claude Fable 5.1".
 *
 * Only kinds whose CLI has version-less ids appear here; everything else is
 * left exactly as the source reported it.
 */
const FAMILY_ALIASES: Partial<Record<DriverKind, Record<string, string>>> = {
  claude: {
    'claude-fable': 'fable',
    'claude-haiku': 'haiku',
    'claude-opus': 'opus',
    'claude-sonnet': 'sonnet',
  },
}

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
const dynamic = new Map<DriverKind, { source: CatalogSource; models: CatalogModel[]; at: number }>()
const dynamicEfforts = new Map<DriverKind, EffortCatalog>()

/**
 * Installs a freshly-fetched catalog for a kind, replacing any previous one.
 * Registry filtering happens while its richer metadata is still available in
 * CatalogService; live data is the harness's own word and is never second-guessed.
 */
export function setDynamicModels(
  kind: DriverKind,
  source: CatalogSource,
  models: CatalogModel[],
): void {
  if (models.length === 0) return
  dynamic.set(kind, { source, models, at: Date.now() })
}

/**
 * When a kind's current catalog was installed, or null when it is not a
 * dynamic one. Callers use this to budget re-discovery: a list an agent
 * reported itself is worth trusting for a while, and re-asking means spawning
 * that agent again to hear the same answer.
 */
export function catalogSetAt(kind: DriverKind): number | null {
  return dynamic.get(kind)?.at ?? null
}

/** Removes any dynamic overlay for a kind (tests, invalidation). */
export function clearDynamicModels(kind: DriverKind): void {
  dynamic.delete(kind)
  agentDefaults.delete(kind)
}

/** Installs the thought/reasoning levels a live ACP probe reported for a kind. */
export function setDynamicEfforts(kind: DriverKind, catalog: EffortCatalog): void {
  if (catalog.options.length === 0) {
    dynamicEfforts.delete(kind)
    return
  }
  dynamicEfforts.set(kind, catalog)
}

/** Removes a kind's effort overlay (tests). */
export function clearDynamicEfforts(kind: DriverKind): void {
  dynamicEfforts.delete(kind)
}

const dynamicModes = new Map<DriverKind, AgentModeCatalog>()

/** Installs the permission modes a live ACP probe reported for a kind. */
export function setDynamicModes(kind: DriverKind, catalog: AgentModeCatalog): void {
  if (catalog.options.length === 0) {
    dynamicModes.delete(kind)
    return
  }
  dynamicModes.set(kind, catalog)
}

/** Removes a kind's mode overlay (tests). */
export function clearDynamicModes(kind: DriverKind): void {
  dynamicModes.delete(kind)
}

const agentDefaults = new Map<DriverKind, string>()

/**
 * Records the model an agent runs when a session names none — Claude's
 * `currentValue` on a fresh session, which follows the CLI's own settings.
 * Null forgets it.
 */
export function setAgentDefaultModel(kind: DriverKind, modelId: string | null): void {
  if (modelId === null || modelId.length === 0) agentDefaults.delete(kind)
  else agentDefaults.set(kind, modelId)
}

/** The model a session without a pick runs on, as the agent last reported it. */
export function agentDefaultModel(kind: DriverKind): string | null {
  return agentDefaults.get(kind) ?? null
}

/** Everything an agent reported about itself, in a form that survives a restart. */
export interface LiveCatalog {
  models: CatalogModel[]
  efforts: EffortCatalog
  modes: AgentModeCatalog
  defaultModelId: string | null
}

/** A kind's agent-reported catalog, or null while it has not answered. */
export function liveCatalogOf(kind: DriverKind): LiveCatalog | null {
  const entry = dynamic.get(kind)
  if (entry?.source !== 'live') return null
  return {
    models: entry.models,
    efforts: dynamicEfforts.get(kind) ?? { currentId: null, options: [] },
    modes: dynamicModes.get(kind) ?? { currentId: null, options: [] },
    defaultModelId: agentDefaultModel(kind),
  }
}

/**
 * Reinstalls a catalog saved by an earlier run. The agent said all of this
 * last time, which beats any registry guess while it is asked again.
 */
export function restoreLiveCatalog(kind: DriverKind, catalog: LiveCatalog): void {
  if (catalog.models.length === 0) return
  setDynamicModels(kind, 'live', catalog.models)
  setDynamicEfforts(kind, catalog.efforts)
  setDynamicModes(kind, catalog.modes)
  setAgentDefaultModel(kind, catalog.defaultModelId)
}

/**
 * Permission modes the harness advertised over ACP, each classified into an
 * Ari mode; empty for kinds with no discovered permission axis, where the
 * picker falls back to Ari's own Ask/Edits/Full-auto vocabulary.
 */
export function modesFor(kind: DriverKind): AgentModeCatalog {
  return dynamicModes.get(kind) ?? { currentId: null, options: [] }
}

/**
 * Thought/reasoning levels the harness advertised, or a kind-specific
 * fallback when we know the CLI's vocabulary (Grok, Ari Core) even before
 * a live ACP probe returns. Empty for kinds with no known selector.
 */
export function effortsFor(kind: DriverKind): EffortCatalog {
  const live = dynamicEfforts.get(kind)
  if (live !== undefined && live.options.length > 0) return live
  return FALLBACK_EFFORTS[kind] ?? { currentId: null, options: [] }
}

const GROK_EFFORTS: EffortCatalog = {
  currentId: 'high',
  options: [
    { id: 'minimal', label: 'Minimal', description: 'Fastest, least reasoning' },
    { id: 'low', label: 'Low', description: 'Some reasoning, still quick' },
    { id: 'medium', label: 'Medium', description: 'Balanced reasoning' },
    { id: 'high', label: 'High', description: 'Deeper reasoning (Grok default)' },
    { id: 'xhigh', label: 'Extra high', description: 'Maximum reasoning depth' },
  ],
}

const ARI_CORE_EFFORTS: EffortCatalog = {
  currentId: 'high',
  options: [
    { id: 'low', label: 'Low', description: 'Faster replies, lighter reasoning' },
    { id: 'medium', label: 'Medium', description: 'Balanced reasoning' },
    { id: 'high', label: 'High', description: 'Deeper reasoning' },
    { id: 'xhigh', label: 'Extra high', description: 'Maximum reasoning depth' },
  ],
}

const FALLBACK_EFFORTS: Partial<Record<DriverKind, EffortCatalog>> = {
  grok: GROK_EFFORTS,
  'ari-core': ARI_CORE_EFFORTS,
}

/**
 * Claude reasoning levels a picker can show before the CLI answers. The live
 * probe replaces these with the model's own advertised set; they exist so the
 * first paint after an install, an offline start or a failed probe still has a
 * usable chip instead of hiding it.
 */
const CLAUDE_FALLBACK_EFFORTS: CatalogEffort[] = [
  { id: 'low', label: 'Low', description: 'Fastest reasoning' },
  { id: 'medium', label: 'Medium', description: 'Balanced reasoning' },
  { id: 'high', label: 'High', description: 'Deeper reasoning' },
  { id: 'xhigh', label: 'Extra high', description: 'Maximum reasoning depth' },
  { id: 'max', label: 'Max', description: 'Highest reasoning depth' },
]

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
  claude: [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-haiku-4-5',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
  ],
  codex: ['gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  grok: ['grok-4.6', 'grok-4.5', 'grok-build-0.1'],
}

function snapshotFor(kind: DriverKind): CatalogModel[] | null {
  const providerId = SNAPSHOT_PROVIDER[kind]
  const models = providerId !== undefined ? (SNAPSHOT.providers[providerId] ?? null) : null
  if (models === null || models.length === 0) return null
  return curateToCurrentModels(kind, models) ?? models
}

/**
 * Narrows a vendor catalog to the ids each CLI serves today; null when there
 * is no curation for the kind or the curation went stale against this data
 * (a full vendor catalog beats an empty picker).
 */
function curateToCurrentModels(kind: DriverKind, models: CatalogModel[]): CatalogModel[] | null {
  const currentIds = CURRENT_MODEL_IDS[kind]
  if (currentIds === undefined) return null
  const current = models.filter((model) => currentIds.includes(model.id))
  return current.length > 0 ? current : null
}

/**
 * Reduces a raw model list to one row per real choice, ready for a picker.
 *
 * Callers pass catalogs newest-first, which is what makes this cheap:
 *
 * 1. **Duplicate display names collapse.** models.dev lists dated variants
 *    under one name ("Claude Haiku 4.5" twice), and two rows a user cannot
 *    tell apart are one row. The newest survives and the other id becomes an
 *    alias, so a session saved against it still resolves.
 * 2. **Version-less family pointers become metadata.** `opus` is not a
 *    fifteenth model, it is another name for the newest Opus — see
 *    {@link FAMILY_ALIASES}.
 * 3. **Superseded family members are flagged legacy**, not dropped: the
 *    picker collapses them behind a disclosure, so pinning an older version
 *    stays possible without them competing with the current ones.
 *
 * Returns new objects; the caller's list is never mutated.
 */
export function collapseCatalog(kind: DriverKind, models: CatalogModel[]): CatalogModel[] {
  const families = FAMILY_ALIASES[kind]
  const pointers = familyPointers(models)
  // A list that already offers `opus` as its own row needs no alias for it:
  // tagging the versioned rows with it too would mark several rows current.
  const ownIds = new Set(models.map((model) => model.id))
  const byLabel = new Map<string, CatalogModel>()
  const kept: CatalogModel[] = []
  for (const model of models) {
    // A pointer is not a choice of its own; its id lands on the row below.
    if (pointers.ids.has(model.id)) continue
    const existing = byLabel.get(model.label)
    if (existing !== undefined) {
      existing.aliases = mergeAliases(existing.aliases, [model.id, ...(model.aliases ?? [])])
      continue
    }
    const next: CatalogModel = { ...model }
    const family = familyKeyOf(next, families)
    const alias = family !== undefined ? families?.[family] : undefined
    // `opus[1m]` is already the pointer; it does not need `opus` as a second name.
    const isPointer = isFamilyPointer(next, families)
    const aliases = mergeAliases(next.aliases, [
      ...(pointers.targets.get(next.id) ?? []),
      ...(alias !== undefined && !ownIds.has(alias) && !isPointer ? [alias] : []),
    ])
    if (aliases.length > 0) next.aliases = aliases
    else delete next.aliases
    byLabel.set(next.label, next)
    kept.push(next)
  }
  return markSuperseded(kept, families).map(withoutFamily)
}

/**
 * Drops the grouping hint from a finished picker row. `family` is how the
 * collapse tells a version-less pointer from a real sibling; it is an input
 * to that decision, not something a picker row carries.
 */
function withoutFamily(model: CatalogModel): CatalogModel {
  const row = { ...model }
  delete row.family
  return row
}

interface FamilyPointers {
  /** Every id that stands in for another row. */
  ids: Set<string>
  /** The concrete row id each pointer folds onto. */
  targets: Map<string, string[]>
}

/**
 * Finds the version-less ids that stand in for concrete ones. models.dev
 * lists both `claude-haiku-4-5` and `claude-haiku-4-5-20251001` under one
 * family, and `gpt-5.6` beside `gpt-5.6-sol`; the shorter id is the floating
 * pointer, and a display name differing only by a "(latest)" suffix is not
 * enough for the label check to pair them up.
 *
 * Same family is required, which is what stops `gpt-5.5` from swallowing
 * `gpt-5.5-pro` — a genuinely different model line that merely shares a prefix.
 * And the rest of the longer id must not continue the version: `claude-opus-5`
 * is Opus 5, not a pointer at `claude-opus-5-5`.
 */
/** A short number right after the shorter id (`-5`, `.1`) is a newer version; a date is not. */
const VERSION_CONTINUATION = /^[-.]\d{1,3}(?:$|[-.])/

function familyPointers(models: CatalogModel[]): FamilyPointers {
  const ids = new Set<string>()
  const targets = new Map<string, string[]>()
  for (const pointer of models) {
    for (const concrete of models) {
      if (concrete.id === pointer.id) continue
      if (pointer.family === undefined || concrete.family !== pointer.family) continue
      if (!concrete.id.startsWith(pointer.id)) continue
      if (VERSION_CONTINUATION.test(concrete.id.slice(pointer.id.length))) continue
      const folded = targets.get(concrete.id) ?? []
      if (!folded.includes(pointer.id)) folded.push(pointer.id)
      targets.set(concrete.id, folded)
      ids.add(pointer.id)
    }
  }
  return { ids, targets }
}

/** The registry's family for a model, or the declared alias prefix without one. */
function familyKeyOf(
  model: CatalogModel,
  families: Record<string, string> | undefined,
): string | undefined {
  if (model.family !== undefined) return model.family
  if (families === undefined) return undefined
  // `opus`, `opus[1m]`: the CLI's own pointer at a family's newest member.
  const bare = bareId(model)
  const pointed = Object.keys(families).find((prefix) => families[prefix] === bare)
  return pointed ?? Object.keys(families).find((prefix) => model.id.startsWith(prefix))
}

/** A model id without its context-window suffix: `opus[1m]` is `opus`. */
function bareId(model: CatalogModel): string {
  return model.id.replace(/\[[^\]]*\]$/, '')
}

/**
 * True for the CLI's own version-less name for a family (`opus`, `opus[1m]`).
 * Unlike a registry pointer, which folds onto a concrete row, this one is a row
 * the agent offers in its own right.
 */
function isFamilyPointer(
  model: CatalogModel,
  families: Record<string, string> | undefined,
): boolean {
  return families !== undefined && Object.values(families).includes(bareId(model))
}

/** Flags every family member after the first — the list is newest-first. */
function markSuperseded(
  models: CatalogModel[],
  families: Record<string, string> | undefined,
): CatalogModel[] {
  if (families === undefined) return models
  const seen = new Set<string>()
  for (const model of models) {
    const family = familyKeyOf(model, families)
    if (family === undefined) continue
    // The CLI's own pointers are current by definition, at any context size:
    // `opus[1m]` beside `opus` is a sibling, not an older model.
    if (isFamilyPointer(model, families)) seen.add(family)
    // Otherwise the first occurrence is the family's newest member.
    else if (seen.has(family)) model.isLegacy = true
    else seen.add(family)
  }
  return models
}

function mergeAliases(current: string[] | undefined, added: readonly string[]): string[] {
  const merged = current === undefined ? [] : [...current]
  for (const id of added) {
    if (id.length > 0 && !merged.includes(id)) merged.push(id)
  }
  return merged
}

/**
 * A model id or display name reduced to what both spellings share: the
 * registry's `claude-opus-5-5` and the agent's "Opus 5.5" both read
 * `opus-5-5`, as do `opus-5.5` and "Claude Opus 5.5".
 */
function modelKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s._]+/g, '-')
    .replace(/^claude-/, '')
}

/**
 * The id an agent knows a requested model by. An exact id wins; otherwise a
 * row whose id or name names the same model does. That is how a pick made
 * from the registry's list (`claude-opus-5-5`, before the agent had answered)
 * still reaches the agent, which calls the same model `opus` and names it
 * "Opus 5.5". Null when nothing on offer is that model.
 */
export function resolveOfferedModel(
  requested: string,
  offered: readonly Pick<CatalogModel, 'id' | 'label' | 'aliases'>[],
): string | null {
  const exact = offered.find(
    (model) => model.id === requested || model.aliases?.includes(requested),
  )
  if (exact !== undefined) return exact.id
  const key = modelKey(requested)
  if (key.length === 0) return null
  return (
    offered.find((model) => modelKey(model.id) === key || modelKey(model.label) === key)?.id ?? null
  )
}

/**
 * Model catalog entries for a driver's picker, merged in priority order:
 * live provider data → cached refresh → bundled snapshot → static defaults.
 * Synchronous and renderer-safe; dynamic overlays arrive via
 * {@link setDynamicModels} in the main process.
 *
 * Collapsing happens here, at read time, so every source — probe, cache,
 * snapshot or static — gets the same one-row-per-choice treatment and the
 * stored catalogs stay exactly as their source reported them.
 */
export function modelsFor(kind: DriverKind): CatalogModel[] {
  const models = dynamic.get(kind)?.models ?? snapshotFor(kind) ?? MODEL_CATALOGS[kind]
  return withFallbackEfforts(kind, collapseCatalog(kind, models))
}

/**
 * Claude rows from a registry or the bundled snapshot carry no reasoning
 * levels. Attach a provisional set so the effort chip is present on first
 * paint; a live catalog is the agent's own word and is left alone.
 */
function withFallbackEfforts(kind: DriverKind, models: CatalogModel[]): CatalogModel[] {
  if (kind !== 'claude' || catalogSource(kind) === 'live') return models
  return models.map((model) =>
    model.efforts !== undefined || !model.id.startsWith('claude-')
      ? model
      : {
          ...model,
          efforts: CLAUDE_FALLBACK_EFFORTS.map((effort) => ({ ...effort })),
          effortsSource: 'fallback' as const,
        },
  )
}
