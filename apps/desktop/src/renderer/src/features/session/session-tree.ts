import type { SessionSummary } from '@ari/contracts/rpc'

export interface SessionTreeRow {
  session: SessionSummary
  depth: number
  childCount: number
  /** For each depth, whether that node is last among siblings. Last entry is this row. */
  lastAtDepth: boolean[]
}

/** Stable preorder, retaining orphans and malformed legacy cycles without dropping rows. */
export function sessionTree(
  sessions: SessionSummary[],
  collapsed: ReadonlySet<string> = new Set(),
): SessionTreeRow[] {
  const ids = new Set(sessions.map((session) => session.id))
  const visited = new Set<string>()
  const rows: SessionTreeRow[] = []
  const children = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    if (session.parentSessionId && ids.has(session.parentSessionId)) {
      const siblings = children.get(session.parentSessionId) ?? []
      siblings.push(session)
      children.set(session.parentSessionId, siblings)
    }
  }
  const visit = (
    session: SessionSummary,
    depth: number,
    lastAtDepth: boolean[],
    hidden = false,
  ): void => {
    if (visited.has(session.id)) return
    visited.add(session.id)
    const nested = children.get(session.id) ?? []
    if (!hidden) rows.push({ session, depth, childCount: nested.length, lastAtDepth })
    for (let i = 0; i < nested.length; i++) {
      const child = nested[i]
      if (!child) continue
      visit(
        child,
        depth + 1,
        [...lastAtDepth, i === nested.length - 1],
        hidden || collapsed.has(session.id),
      )
    }
  }
  for (const session of sessions)
    if (!session.parentSessionId || !ids.has(session.parentSessionId)) visit(session, 0, [])
  for (const session of sessions) if (!visited.has(session.id)) visit(session, 0, [])
  return rows
}

/** Search keeps ancestor context, even when the match is archived or its parent is collapsed. */
export function searchSessionTree(sessions: SessionSummary[], query: string): SessionSummary[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const keep = new Set<string>()
  for (const match of sessions.filter((session) =>
    session.title.toLowerCase().includes(query.toLowerCase()),
  )) {
    let session: SessionSummary | undefined = match
    while (session && !keep.has(session.id)) {
      keep.add(session.id)
      session = session.parentSessionId ? byId.get(session.parentSessionId) : undefined
    }
  }
  return sessions.filter((session) => keep.has(session.id))
}
