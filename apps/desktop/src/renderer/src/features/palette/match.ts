/**
 * Fuzzy matcher behind the command palette (M2.7). Scores a query against a
 * label in three tiers — exact prefix > substring > subsequence — with a
 * length-difference penalty inside each tier so tighter labels rank first.
 */
export const SCORE_EXACT_PREFIX = 100
export const SCORE_SUBSTRING = 60
export const SCORE_SUBSEQUENCE = 30

/** Score subtracted per character of length difference within a tier. */
const LENGTH_DIFF_PENALTY = 0.5

/** Floor for any match, so every match outranks a non-match (0). */
const MIN_MATCH_SCORE = 1

function isSubsequence(query: string, label: string): boolean {
  let cursor = 0
  for (let i = 0; i < label.length && cursor < query.length; i++) {
    if (label[i] === query[cursor]) cursor++
  }
  return cursor === query.length
}

/**
 * Score `query` against `label`, case-insensitively. Returns 0 for an empty
 * query or when the query is not a subsequence of the label; otherwise a
 * tiered score with the length-difference penalty applied.
 */
export function score(query: string, label: string): number {
  const q = query.trim().toLowerCase()
  const l = label.toLowerCase()
  if (q === '') return 0
  const penalized = (base: number): number =>
    Math.max(base - Math.abs(l.length - q.length) * LENGTH_DIFF_PENALTY, MIN_MATCH_SCORE)
  if (l.startsWith(q)) return penalized(SCORE_EXACT_PREFIX)
  if (l.includes(q)) return penalized(SCORE_SUBSTRING)
  if (isSubsequence(q, l)) return penalized(SCORE_SUBSEQUENCE)
  return 0
}

/**
 * Filter and rank commands for a palette query. An empty query returns every
 * command in registry order; otherwise matches are sorted by score
 * descending, ties keeping registry order.
 */
export function matchCommands<T extends { label: string }>(
  commands: readonly T[],
  query: string,
): T[] {
  if (query.trim() === '') return [...commands]
  return commands
    .map((command) => ({ command, rank: score(query, command.label) }))
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .map(({ command }) => command)
}
