/** Short stable key so a later release can find this session's branch. */
export function branchKey(sessionId: string): string {
  const body = sessionId.startsWith('sess_') ? sessionId.slice('sess_'.length) : sessionId
  const compact = body.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  if (compact.length >= 4) return compact.slice(0, 8)
  const fallback = sessionId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  return (fallback.length > 0 ? fallback : 'child').slice(0, 12)
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

/** `ari/edit-queued-message-c2825b69`, or `ari/<key>` when the title has no words. */
export function orchestrationBranch(title: string, sessionId: string): string {
  const key = branchKey(sessionId)
  const slug = branchSlug(title)
  const name = slug.length > 0 && slug !== key ? `${slug}-${key}` : key
  return `ari/${name}`
}

/**
 * True for this session's branch, a numbered collision of it, and the older
 * `ari/<parent>/<sessionId>` form.
 */
export function branchBelongsToSession(branch: string, sessionId: string): boolean {
  if (!branch.startsWith('ari/') || branch.includes('..') || branch.includes('\\')) return false
  if (branch.endsWith(`/${sessionId}`)) return true
  const leaf = branch.slice('ari/'.length)
  if (leaf.includes('/')) return false
  const key = branchKey(sessionId)
  return new RegExp(`(?:^|-)${key}(?:-\\d+)?$`).test(leaf)
}
