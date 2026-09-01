import type { AcpConfigOption, AcpNewSessionResult } from './protocol'

/**
 * One thought/reasoning level a harness advertised. `id` is the wire value
 * Ari must send back through `session/set_config_option` (or `set_mode`
 * when the agent's only axis is thinking).
 */
export interface CatalogEffort {
  id: string
  label: string
  description?: string
}

export interface EffortCatalog {
  /** Agent's current value at probe time; null when it did not say. */
  currentId: string | null
  options: CatalogEffort[]
}

const THOUGHT_CATEGORY = 'thought_level'
const THOUGHT_NAME_RE = /thought|thinking|effort|reasoning/i
const THOUGHT_VALUE_RE = /^(off|none|minimal|low|med(ium)?|high|xhigh|max|extra-?high)$/i
const PERMISSION_VALUE_RE =
  /\b(plan(ning)?|build|accept.?edits?|bypass|yolo|workspace|read.?only|chat)\b/i

/**
 * Picks the config option that is a thought/reasoning selector.
 *
 * Prefers the spec category `thought_level`, then id/name/category that look
 * like effort/thinking — never `model` or `mode`, which have their own chips.
 */
export function findThoughtOption(configOptions: AcpConfigOption[]): AcpConfigOption | null {
  // ACP's default type is select; Grok omits `type` on reasoning_effort.
  const select = configOptions.filter((o) => o.type === undefined || o.type === 'select')
  const byCategory = select.find((o) => o.category === THOUGHT_CATEGORY)
  if (byCategory !== undefined) return byCategory
  return (
    select.find((o) => {
      if (o.category === 'model' || o.category === 'mode') return false
      return (
        THOUGHT_NAME_RE.test(o.id ?? '') ||
        THOUGHT_NAME_RE.test(o.name ?? '') ||
        THOUGHT_NAME_RE.test(o.category ?? '')
      )
    }) ?? null
  )
}

/** True when a mode list is thinking levels, not permissions (pi's axis). */
export function looksLikeThoughtAxis(values: (string | undefined)[]): boolean {
  const ids = values.filter((v): v is string => typeof v === 'string' && v.length > 0)
  if (ids.length === 0) return false
  if (ids.some((v) => PERMISSION_VALUE_RE.test(v))) return false
  return ids.filter((v) => THOUGHT_VALUE_RE.test(v)).length >= 2
}

function optionsOf(option: AcpConfigOption): CatalogEffort[] {
  const out: CatalogEffort[] = []
  for (const value of option.options ?? []) {
    if (typeof value.value !== 'string' || value.value.length === 0) continue
    const label =
      typeof value.name === 'string' && value.name.length > 0 ? value.name : value.value
    const description =
      typeof value.description === 'string' && value.description.length > 0
        ? value.description
        : undefined
    out.push({ id: value.value, label, ...(description !== undefined ? { description } : {}) })
  }
  return out
}

function currentOf(option: AcpConfigOption): string | null {
  return typeof option.currentValue === 'string' && option.currentValue.length > 0
    ? option.currentValue
    : null
}

/**
 * Thought/reasoning levels advertised on a new or loaded ACP session.
 * Config options win; a thinking-shaped `modes` list is the fallback used
 * by agents (pi) that model effort as `session/set_mode`.
 */
export function thoughtEffortsFromSession(created: AcpNewSessionResult): EffortCatalog {
  const option = findThoughtOption(created.configOptions ?? [])
  if (option !== null) {
    const options = optionsOf(option)
    if (options.length > 0) return { currentId: currentOf(option), options }
  }
  const modes = created.modes?.availableModes ?? []
  const ids = modes.map((m) => m.id)
  if (!looksLikeThoughtAxis(ids)) return { currentId: null, options: [] }
  const options: CatalogEffort[] = []
  for (const mode of modes) {
    if (typeof mode.id !== 'string' || mode.id.length === 0) continue
    options.push({
      id: mode.id,
      label: typeof mode.name === 'string' && mode.name.length > 0 ? mode.name : mode.id,
    })
  }
  const current =
    typeof created.modes?.currentModeId === 'string' ? created.modes.currentModeId : null
  return { currentId: current, options }
}

/**
 * Grok (and some adapters) put per-model reasoning levels on initialize
 * `_meta.modelState.availableModels[]` rather than as a session config option.
 */
export function thoughtEffortsFromMeta(meta: unknown): EffortCatalog {
  const root = asRecord(meta)
  const models =
    asArray(asRecord(root?.['modelState'])?.['availableModels']) ??
    asArray(root?.['availableModels']) ??
    asArray(asRecord(root?.['modelState'])?.['models'])
  if (models === null) return { currentId: null, options: [] }
  const seen = new Map<string, CatalogEffort>()
  let currentId: string | null = null
  for (const model of models) {
    const rec = asRecord(model)
    if (rec === null) continue
    const nested = asRecord(rec['_meta']) ?? rec
    const current =
      str(nested, 'reasoningEffort') ||
      str(nested, 'reasoning_effort') ||
      str(nested, 'defaultReasoningEffort')
    if (current.length > 0 && currentId === null) currentId = current
    const list =
      asArray(nested['reasoningEfforts']) ??
      asArray(nested['reasoning_efforts']) ??
      asArray(nested['supportedReasoningEfforts'])
    if (list === null) continue
    for (const item of list) {
      if (typeof item === 'string' && item.length > 0 && !seen.has(item)) {
        seen.set(item, { id: item, label: labelForEffort(item) })
        continue
      }
      const opt = asRecord(item)
      if (opt === null) continue
      const id = str(opt, 'value') || str(opt, 'id') || str(opt, 'effort')
      if (id.length === 0 || seen.has(id)) continue
      const label = str(opt, 'name') || str(opt, 'label') || labelForEffort(id)
      seen.set(id, { id, label })
    }
  }
  return { currentId, options: [...seen.values()] }
}

export function mergeEffortCatalogs(...catalogs: EffortCatalog[]): EffortCatalog {
  const seen = new Map<string, CatalogEffort>()
  let currentId: string | null = null
  for (const catalog of catalogs) {
    if (catalog.currentId !== null && currentId === null) currentId = catalog.currentId
    for (const option of catalog.options) {
      if (!seen.has(option.id)) seen.set(option.id, option)
    }
  }
  return { currentId, options: [...seen.values()] }
}

function labelForEffort(id: string): string {
  switch (id) {
    case 'minimal':
      return 'Minimal'
    case 'low':
      return 'Low'
    case 'medium':
      return 'Medium'
    case 'high':
      return 'High'
    case 'xhigh':
      return 'Extra high'
    default:
      return id
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v.trim() : ''
}
