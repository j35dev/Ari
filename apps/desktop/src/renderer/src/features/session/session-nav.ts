import type { SessionSummary } from '@ari/contracts/rpc'
import { sessionTree } from './session-tree'
import { collapsedSessions } from '../../shell/use-session-collapse'

/**
 * The ad-hoc project id, doubling as the sidebar's Unfiled group: it collects
 * both sessions started with no project and any whose project is not open.
 */
export const UNFILED_GROUP_ID = 'adhoc'

/**
 * The folder a shell may open in for a session, or null when there is nowhere
 * it could run.
 *
 * `terminal.create` jails its working directory against the registered project
 * folders plus managed session worktrees, so the answer has to be one of those
 * and the order below is load-bearing:
 *
 * - An ad-hoc session resolves its workspace to the home directory, which the
 *   jail never accepts — null whatever else resolved, because a path from that
 *   bucket is a lie even when it came back cleanly.
 * - A resolved workspace wins otherwise. It is a project folder or a managed
 *   worktree, both trusted, and a worktree outlives the project it was cut
 *   from — removing that project must not tear down its running shells.
 * - Falling through, the session's own project folder. The resolved workspace
 *   arrives a beat late on a session switch, and the empty state in that gap
 *   would blink the rail on every switch.
 *
 * A removed project is gone from the registry, so nothing matches and its
 * sessions land on null: the rail offers to add a folder, which is the same
 * move that brings those sessions back.
 */
export function shellRootFor(
  session: { projectId: string } | undefined,
  // The active pane root — a session's resolved workspace, or the first
  // registered project when nothing is selected.
  resolvedPath: string | null,
  projects: readonly { id: string; path: string }[],
): string | null {
  if (session === undefined) return resolvedPath
  if (session.projectId === UNFILED_GROUP_ID) return null
  if (resolvedPath !== null) return resolvedPath
  return projects.find((p) => p.id === session.projectId)?.path ?? null
}

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

/** Newest first; the Sessions inbox has no date buckets. */
function byRecency(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt - a.updatedAt
}

/**
 * Sessions bucketed under the open projects, in the projects' own order, with
 * an Unfiled group last for ad-hoc sessions (and sessions whose project is
 * closed, so closing a project never hides its work). Archived sessions are
 * excluded — they live in the global shelf.
 */
export function sidebarGroups(sessions: SessionSummary[], projects: NavProject[]): SidebarGroup[] {
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

/** The Sessions view's flat inbox: pinned roots, then every other root. */
export interface SessionInboxSplit {
  /** Pinned root threads, newest first. */
  pinned: SessionSummary[]
  /** Unpinned root threads, newest first. */
  active: SessionSummary[]
}

/**
 * Split the Sessions view into roots only: child agents stay inside their
 * parent's thread rather than appearing as separate sidebar rows. Archived
 * sessions never enter this split.
 */
export function inboxSplit(sessions: SessionSummary[]): SessionInboxSplit {
  const pinned: SessionSummary[] = []
  const active: SessionSummary[] = []
  for (const session of sessions) {
    if (session.archived || session.parentSessionId) continue
    if (session.pinned) pinned.push(session)
    else active.push(session)
  }
  pinned.sort(byRecency)
  active.sort(byRecency)
  return { pinned, active }
}

/**
 * The Sessions view's visible order: pinned roots, then the flat active
 * threads, matching what `SessionsUnderProjects` renders so keyboard traversal
 * never jumps to a row the eye cannot place.
 */
export function sessionsViewOrder(sessions: SessionSummary[]): SessionSummary[] {
  const { pinned, active } = inboxSplit(sessions)
  return [...pinned, ...active]
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
    return sessionTree(
      [...sessions].filter((s) => !s.archived).sort(byPinnedThenRecency),
      collapsedSessions(),
    ).map((row) => row.session)
  }
  return sidebarGroups(sessions, projects).flatMap((g) =>
    sessionTree(g.sessions, collapsedSessions()).map((row) => row.session),
  )
}

/** One sidebar-reorder step: place `id` immediately before `beforeId` (null = last). */
export interface ProjectMove {
  id: string
  beforeId: string | null
}

/**
 * The move a drag produced: `draggedId` landed at a new spot in `to`, so it
 * slots ahead of whatever follows it there. Null when the gesture never
 * changed the order (a press, or a drop back onto the original slot).
 */
export function projectMoveFromOrder(
  from: string[],
  to: string[],
  draggedId: string,
): ProjectMove | null {
  const nextIndex = to.indexOf(draggedId)
  if (nextIndex === -1) return null
  const beforeId = to[nextIndex + 1] ?? null
  const previousIndex = from.indexOf(draggedId)
  if (previousIndex === -1 || (from[previousIndex + 1] ?? null) === beforeId) return null
  return { id: draggedId, beforeId }
}

/**
 * The move for a one-slot nudge (the project menu's Move up / Move down, the
 * keyboard path). Null at the edges where there is no neighbour to swap with.
 */
export function projectMoveForDelta(
  openIds: string[],
  id: string,
  delta: -1 | 1,
): ProjectMove | null {
  const index = openIds.indexOf(id)
  const target = index + delta
  if (index === -1 || target < 0 || target >= openIds.length) return null
  return delta === -1
    ? { id, beforeId: openIds[target] as string }
    : { id, beforeId: openIds[target + 1] ?? null }
}

/**
 * New array with `id` slotted before `beforeId` (null = last) — the same
 * splice `ProjectStore.move` persists, applied locally so the drop tracks the
 * cursor instead of waiting for the round-trip. Returns the input untouched
 * for unknown ids.
 */
export function moveProjectInList<T extends { id: string }>(
  projects: T[],
  id: string,
  beforeId: string | null,
): T[] {
  const dragged = projects.find((p) => p.id === id)
  if (!dragged) return projects
  const without = projects.filter((p) => p.id !== id)
  const index = beforeId === null ? without.length : without.findIndex((p) => p.id === beforeId)
  if (index === -1) return projects
  return [...without.slice(0, index), dragged, ...without.slice(index)]
}
