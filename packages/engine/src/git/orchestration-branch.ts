import { createHash } from 'node:crypto'

/** Full session identity; legacy truncated keys are never cleanup authority. */
export function branchKey(sessionId: string): string {
  return `s_${createHash('sha256').update(sessionId).digest('hex')}`
}

/** Git-safe words from a child title. Empty when the title has none. */
export function branchSlug(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, 40).replace(/-+$/g, '')
}

/** A readable title followed by the full identity key, or just the key. */
export function orchestrationBranch(title: string, sessionId: string): string {
  const key = branchKey(sessionId)
  const slug = branchSlug(title)
  const name = slug.length > 0 && slug !== key ? `${slug}-${key}` : key
  return `ari/${name}`
}

/**
 * True for this session's branch, a numbered collision of it, and the older
 * `ari/<parent>/<sessionId>` form. Ambiguous legacy short-key branches are retained.
 */
export function branchBelongsToSession(branch: string, sessionId: string): boolean {
  if (!branch.startsWith('ari/') || branch.includes('..') || branch.includes('\\')) return false
  if (branch.endsWith(`/${sessionId}`)) return true
  const leaf = branch.slice('ari/'.length)
  if (leaf.includes('/')) return false
  const key = branchKey(sessionId)
  return new RegExp(`(?:^|-)${key}(?:-\\d+)?$`).test(leaf)
}
