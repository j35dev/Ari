/**
 * Session title generation. The decider stamps an immediate slice of the
 * first prompt (`deriveSliceTitle`) when a turn starts; after the first turn
 * settles, the engine upgrades the title through a {@link TitleStrategy}.
 * The bundled strategy is deterministic (no network); a later worker can
 * plug an LLM-backed strategy without touching the engine flow.
 */

/** Hard sidebar-title cap, shared by every strategy. */
export const MAX_TITLE_LENGTH = 48

/** Title the UI assigns to pristine sessions until something names them. */
export const DEFAULT_SESSION_TITLE = 'New session'

/** Input to a title strategy. */
export interface TitleRequest {
  /** First user message of the conversation. */
  prompt: string
  /** Current sidebar title — the automatic slice while untouched. */
  currentTitle: string
}

/**
 * Extension point for session titling. Implementations must stay cheap,
 * run off the turn hot path, and return `null` (keep current title) instead
 * of throwing on any input.
 */
export interface TitleStrategy {
  generate(request: TitleRequest): Promise<string | null>
}

/** The default slice: first line, capped at {@link MAX_TITLE_LENGTH}. */
export function deriveSliceTitle(prompt: string): string {
  const trimmed = prompt.trim()
  const firstLine = trimmed.split('\n')[0] ?? trimmed
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine
  return `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…`
}

/**
 * True while the session title is still automatic — i.e. safe to upgrade.
 * A manual rename never matches and is respected forever.
 */
export function isAutoTitle(title: string, prompt: string): boolean {
  return (
    title.length === 0 ||
    title === DEFAULT_SESSION_TITLE ||
    title === deriveSliceTitle(prompt)
  )
}

/** Courtesy/filler tokens dropped from the head of a candidate title. */
const LEADING_FILLER = new Set([
  'hey',
  'hi',
  'hello',
  'yo',
  'ok',
  'okay',
  'thanks',
  'thank',
  'please',
  'pls',
  'kindly',
  'can',
  'could',
  'would',
  'will',
  'shall',
  'you',
  'u',
  'we',
  'i',
  'me',
  'my',
  'us',
  'help',
  'let',
  'lets',
  'just',
  'so',
])

function normalizeToken(word: string): string {
  return word.toLowerCase().replace(/[^a-z']/g, '')
}

/** Removes markdown decoration so prose survives as a plain title. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
    .replace(/(\*\*\*|\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
}

/** Deterministic quality title from the first prompt; null when nothing usable remains. */
export function generateQualityTitle(prompt: string): string | null {
  const flattened = stripMarkdown(prompt.replace(/\r/g, '')).replace(/\s+/g, ' ').trim()
  if (flattened.length === 0) return null
  const firstSentence = flattened.split(/(?<=[.!?])\s+/)[0] ?? flattened
  const words = firstSentence.split(' ').filter((w) => w.length > 0)
  const kept: string[] = []
  for (let i = 0; i < words.length; i++) {
    if (kept.length === 0 && LEADING_FILLER.has(normalizeToken(words[i] ?? ''))) continue
    kept.push(words[i] ?? '')
  }
  const body = (kept.length > 0 ? kept.join(' ') : firstSentence)
    .replace(/[.!?:;,—–]+$/, '')
    .trim()
  if (body.length === 0) return null
  const titled = body.charAt(0).toUpperCase() + body.slice(1)
  if (titled.length <= MAX_TITLE_LENGTH) return titled
  return `${titled.slice(0, MAX_TITLE_LENGTH - 1)}…`
}

/** Bundled no-network strategy backed by {@link generateQualityTitle}. */
export const deterministicTitleStrategy: TitleStrategy = {
  generate: (request) => Promise.resolve(generateQualityTitle(request.prompt)),
}
