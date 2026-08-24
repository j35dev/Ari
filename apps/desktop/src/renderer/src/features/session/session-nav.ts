import type { SessionSummary } from '@ari/contracts/rpc'

/** Group id holding sessions that belong to no open project (`projectId: 'adhoc'`). */
export const UNFILED_GROUP_ID = 'adhoc'

/** Minimal project shape the sidebar groups sessions under. */
export interface NavProject {
  id: string
  name: string
}

/** One rendered sidebar group: a project (or Unfiled) plus its sessions. */
export interface SidebarGroup {
  id: string
  name: string
  sessions: SessionSummary[]
}

/** Pinned float above recency — the rule inside every group. */
function byPinnedThenRecency(a: SessionSummary, b: SessionSummary): number {
  if ((a.pinned ?? false) !== (b.pinned ?? false)) return a.pinned ? -1 : 1
  return b.updatedAt - a.updatedAt
}

/**
 * Sessions bucketed under the open projects, in the projects' own order, with
 * an Unfiled group last for ad-hoc sessions (and sessions whose project is
 * closed, so closing a project never hides its work). Archived sessions are
 * excluded — they live in the global shelf.
 */
export function sidebarGroups(
  sessions: SessionSummary[],
  projects: NavProject[],
): SidebarGroup[] {
  const groups: SidebarGroup[] = projects.map((p) => ({ id: p.id, name: p.name, sessions: [] }))
  const byId = new Map(groups.map((g) => [g.id, g]))
  const unfiled: SidebarGroup = { id: UNFILED_GROUP_ID, name: 'Unfiled', sessions: [] }
  for (const session of sessions) {
    if (session.archived) continue
    ;(byId.get(session.projectId) ?? unfiled).sessions.push(session)
  }
  for (const group of groups) group.sessions.sort(byPinnedThenRecency)
  unfiled.sessions.sort(byPinnedThenRecency)
  return unfiled.sessions.length > 0 ? [...groups, unfiled] : groups
}

/**
 * Canonical visible-session order. Without projects it is pinned-first then
 * newest; with open projects it walks the rendered groups top to bottom so
 * Mod+1..9 / Ctrl+Tab never diverge from what the user sees. Archived
 * sessions are always excluded — they live in their own collapsed shelf.
 */
export function sidebarOrder(
  sessions: SessionSummary[],
  projects: NavProject[] = [],
): SessionSummary[] {
  if (projects.length === 0) {
    return [...sessions].filter((s) => !s.archived).sort(byPinnedThenRecency)
  }
  return sidebarGroups(sessions, projects).flatMap((g) => g.sessions)
}
