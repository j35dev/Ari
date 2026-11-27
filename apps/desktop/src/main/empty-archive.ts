import type { SessionListEntry } from '@ari/engine/session-store'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:empty-archive')
const CONCURRENT_TREES = 4

type ArchiveRow = Pick<SessionListEntry, 'id' | 'parentSessionId' | 'archived'>

/** Delete confirmed archive rows from a single inventory snapshot. Keep any
 * parent that still has a child, including a restored child or a failed delete. */
export async function emptyArchive(
  rows: readonly ArchiveRow[],
  confirmedIds: readonly string[],
  destroy: (row: ArchiveRow) => Promise<boolean>,
): Promise<string[]> {
  const confirmed = new Set(confirmedIds)
  const targets = new Map(
    rows.filter((row) => row.archived && confirmed.has(row.id)).map((row) => [row.id, row]),
  )
  const children = new Map<string, ArchiveRow[]>()
  for (const row of rows) {
    if (!row.parentSessionId || !targets.has(row.parentSessionId)) continue
    const siblings = children.get(row.parentSessionId) ?? []
    siblings.push(row)
    children.set(row.parentSessionId, siblings)
  }
  const roots = [...targets.values()].filter((row) => !targets.has(row.parentSessionId ?? ''))
  const deleted: string[] = []
  async function destroyTree(row: ArchiveRow): Promise<boolean> {
    let childKept = false
    for (const child of children.get(row.id) ?? []) {
      if (!targets.has(child.id) || !(await destroyTree(child))) childKept = true
    }
    if (childKept) return false
    try {
      if (!(await destroy(row))) return false
      deleted.push(row.id)
      return true
    } catch (error) {
      log.warn('archived session deletion failed', { sessionId: row.id, error: String(error) })
      return false
    }
  }
  // Parallelize independent trees without opening every journal or running
  // worktree cleanup for the whole archive at once.
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(roots.length, CONCURRENT_TREES) }, async () => {
      for (let root = roots[next++]; root; root = roots[next++]) await destroyTree(root)
    }),
  )
  return deleted
}
