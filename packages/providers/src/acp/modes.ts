import type { PermissionMode } from '@ari/contracts/common'
import type { AcpConfigOption, AcpNewSessionResult } from './protocol'

/**
 * Mapping between Ari's permission modes and the mode vocabulary an ACP agent
 * advertises (`session/new` config options or `modes.availableModes`), plus the
 * classifier that feeds the UI's mode picker: the harness's own modes (codex
 * `yolo`, claude `bypassPermissions`, opencode `build`…) labeled with the Ari
 * mode each one behaves like.
 */

/** Modes that make an agent refuse to write; a build mode must never land here. */
const PLANNING_PATTERNS = [/\bplan(ning)?\b/i, /read.?only/i, /\bchat\b/i, /\bask\b/i]

const ASK_PATTERNS = [
  /\bask\b/i,
  /\bdefault\b/i,
  /\bnormal\b/i,
  /\bstandard\b/i,
  /\bplan(ning)?\b/i,
]
// `build` is opencode's write-capable mode; `code` is the same idea elsewhere.
const EDIT_PATTERNS = [
  /accept.?edits?/i,
  /\bedit(s|ing)?\b/i,
  /\bworkspace\b/i,
  /\bbuild\b/i,
  /^code$/i,
]
/**
 * Full-permission flavors, tiered. A `bypass`-flavored id skips permission
 * checks outright; `auto` delegates each approval to a model classifier —
 * claude-agent-acp advertises both, lists `auto` first, and a classifier
 * outage turns every tool call into a hard failure ("auto mode cannot
 * determine the safety of Bash"). The bypass tier must always win.
 */
const BYPASS_PATTERNS = [/bypass/i, /yolo/i, /danger/i, /\bfull\b/i]
const AUTO_PATTERNS = [/\bauto\b/i]
/** Classification only — preference order comes from the tiers above. */
const FULL_PATTERNS = [...BYPASS_PATTERNS, ...AUTO_PATTERNS]

/** Preference chain per Ari mode: first tier with a matching value wins. */
const MODE_PREFERENCE: Record<PermissionMode, RegExp[][]> = {
  ask: [ASK_PATTERNS],
  'allow-edits': [EDIT_PATTERNS, BYPASS_PATTERNS, AUTO_PATTERNS],
  full: [BYPASS_PATTERNS, AUTO_PATTERNS, EDIT_PATTERNS],
}

/**
 * Whether an advertised vocabulary is about permissions at all.
 *
 * `session/set_mode` carries no category, so the mode list is whatever axis the
 * agent happens to model as "modes" — and for pi's ACP adapter that axis is the
 * *thinking* level (`off`, `minimal`, … `xhigh`). Ari must be able to tell the
 * two apart before it writes anything: one recognizable permission word in the
 * list is the evidence that the axis is Ari's to drive.
 */
function looksLikePermissionAxis(values: string[]): boolean {
  const vocabulary = [...PLANNING_PATTERNS, ...ASK_PATTERNS, ...EDIT_PATTERNS, ...FULL_PATTERNS]
  return values.some((value) => matchesAny(value, vocabulary))
}

/**
 * Resolves an Ari permission mode against the mode vocabulary an agent
 * advertises, in candidate order. Returns null when nothing safe matches, which
 * the caller reads as "leave the agent alone".
 *
 * The two build modes take a last-resort escape hatch that `ask` deliberately
 * does not: any advertised mode that is not a planning/read-only mode. Agents
 * whose write mode Ari cannot name (opencode's `build` before it was listed
 * here) would otherwise be stranded in the planning mode a previous Ask-mode
 * turn selected, with no way out from inside Ari. Guessing in the other
 * direction would silently escalate permissions, so `ask` never falls back.
 *
 * The hatch is gated on {@link looksLikePermissionAxis}: applied to a list that
 * is not about permissions it picks the first entry, which is how an
 * allow-edits turn against pi used to send `set_mode('off')` and silently
 * disable the agent's reasoning.
 */
export function pickAgentMode(
  candidates: (string | undefined)[],
  mode: PermissionMode,
): string | null {
  const values = candidates.filter((v): v is string => typeof v === 'string' && v.length > 0)
  for (const patterns of MODE_PREFERENCE[mode]) {
    const match = values.find((v) => matchesAny(v, patterns))
    if (match !== undefined) return match
  }
  if (mode === 'ask') return null
  if (!looksLikePermissionAxis(values)) return null
  return values.find((v) => !matchesAny(v, PLANNING_PATTERNS)) ?? null
}

/**
 * Which Ari mode a single advertised mode behaves like, most permissive match
 * first (a `yolo`-flavored id is never read as merely ask). Null when the id
 * is not recognizably about permissions.
 */
export function classifyAgentMode(value: string): PermissionMode | null {
  if (matchesAny(value, FULL_PATTERNS)) return 'full'
  if (matchesAny(value, EDIT_PATTERNS)) return 'allow-edits'
  if (matchesAny(value, [...ASK_PATTERNS, ...PLANNING_PATTERNS])) return 'ask'
  return null
}

function matchesAny(value: string | boolean | undefined, patterns: RegExp[]): boolean {
  return typeof value === 'string' && patterns.some((p) => p.test(value))
}

/** One native mode a harness advertised, with its Ari-side classification. */
export interface CatalogAgentMode {
  id: string
  label: string
  description?: string
  /** Ari mode this native id maps onto; null when unrecognized. */
  ariMode: PermissionMode | null
}

export interface AgentModeCatalog {
  /** Agent's current mode at probe time; null when it did not say. */
  currentId: string | null
  options: CatalogAgentMode[]
}

const EMPTY_MODE_CATALOG: AgentModeCatalog = { currentId: null, options: [] }

/** The `mode`-category select option, if the agent exposes one. */
export function findModeOption(configOptions: AcpConfigOption[]): AcpConfigOption | null {
  return configOptions.find((o) => o.category === 'mode' && o.type === 'select') ?? null
}

/**
 * Permission modes advertised on a new ACP session, each classified into an
 * Ari mode. Config options win; a permission-shaped `modes` list is the
 * fallback. Empty when the agent exposes no recognizable permission axis —
 * thinking axes (pi) and unknown vocabularies are left alone.
 */
export function agentModesFromSession(created: AcpNewSessionResult): AgentModeCatalog {
  const option = findModeOption(created.configOptions ?? [])
  if (option !== null) {
    const options: CatalogAgentMode[] = []
    for (const value of option.options ?? []) {
      if (typeof value.value !== 'string' || value.value.length === 0) continue
      options.push({
        id: value.value,
        label:
          typeof value.name === 'string' && value.name.length > 0 ? value.name : value.value,
        ...(typeof value.description === 'string' && value.description.length > 0
          ? { description: value.description }
          : {}),
        ariMode: classifyAgentMode(value.value),
      })
    }
    if (options.some((o) => o.ariMode !== null)) {
      return {
        currentId:
          typeof option.currentValue === 'string' && option.currentValue.length > 0
            ? option.currentValue
            : null,
        options,
      }
    }
    return EMPTY_MODE_CATALOG
  }

  const modes = created.modes?.availableModes ?? []
  const ids = modes
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (!looksLikePermissionAxis(ids)) return EMPTY_MODE_CATALOG
  const options: CatalogAgentMode[] = []
  for (const mode of modes) {
    if (typeof mode.id !== 'string' || mode.id.length === 0) continue
    options.push({
      id: mode.id,
      label: typeof mode.name === 'string' && mode.name.length > 0 ? mode.name : mode.id,
      ariMode: classifyAgentMode(mode.id),
    })
  }
  if (!options.some((o) => o.ariMode !== null)) return EMPTY_MODE_CATALOG
  return {
    currentId: typeof created.modes?.currentModeId === 'string' ? created.modes.currentModeId : null,
    options,
  }
}
