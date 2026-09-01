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
  const select = configOptions.filter((o) => o.type === 'select')
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
