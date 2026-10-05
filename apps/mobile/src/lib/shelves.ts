import type { RemoteAttention, RemoteProject } from '@ari/contracts/remote'
import type { SessionSummary } from '@ari/contracts/rpc'

type AttentionItem = RemoteAttention['items'][number]

export interface ShelfRow {
  session: SessionSummary
  /** What the session is waiting on, for a row on the "Needs you" shelf. */
  ask: string | null
}
export interface Shelf {
  id: 'needs-you' | 'working' | 'pinned' | 'recent' | 'archived'
  title: string
  rows: ShelfRow[]
}
export interface ShelfFilter {
  projectId: string | null
  query: string
  projects: readonly Pick<RemoteProject, 'id' | 'name'>[]
  /** Whether the archived shelf is shown at all. */
  archived: boolean
}

function askOf(item: AttentionItem): string | null {
  const [approval] = item.pendingApprovals
  if (approval !== undefined) {
    const more = item.pendingApprovals.length - 1
    return `Wants to use ${approval.toolName}${more > 0 ? `, and ${more} more` : ''}`
  }
  return item.pendingInputs[0]?.prompt ?? item.error
}

/**
 * The home list: every session on exactly one shelf, the most urgent first.
 * `attention` is the desktop's list of blocked sessions, or `null` when it
 * cannot provide one and session status has to stand in.
 */
export function shelve(
  sessions: readonly SessionSummary[],
  attention: readonly AttentionItem[] | null,
  filter: ShelfFilter,
): Shelf[] {
  const needle = filter.query.trim().toLowerCase()
  const asks = new Map<string, string>()
  const known = new Set(sessions.map((session) => session.id))
  const all = [...sessions]
  for (const item of attention ?? []) {
    const ask = askOf(item)
    if (ask === null) continue
    asks.set(item.sessionId, ask)
    // The blocked list can be fresher than the session list it is drawn beside.
    if (!known.has(item.sessionId))
      all.push({
        id: item.sessionId,
        projectId: item.projectId,
        title: item.title,
        status: item.status,
        updatedAt: item.updatedAt,
        messageCount: 0,
      })
  }
  const shelves: Record<Shelf['id'], ShelfRow[]> = {
    'needs-you': [],
    working: [],
    pinned: [],
    recent: [],
    archived: [],
  }
  for (const session of all.sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (filter.projectId !== null && session.projectId !== filter.projectId) continue
    const project = filter.projects.find((entry) => entry.id === session.projectId)?.name ?? ''
    if (needle && !`${session.title} ${project}`.toLowerCase().includes(needle)) continue
    const ask =
      asks.get(session.id) ??
      (attention !== null
        ? null
        : session.status === 'waiting-approval'
          ? 'Waiting for your approval'
          : session.status === 'error'
            ? 'Stopped with an error'
            : null)
    const shelf: Shelf['id'] =
      session.archived === true
        ? 'archived'
        : ask !== null
          ? 'needs-you'
          : session.status === 'running'
            ? 'working'
            : session.pinned === true
              ? 'pinned'
              : 'recent'
    shelves[shelf].push({ session, ask: shelf === 'needs-you' ? ask : null })
  }
  const titles: [Shelf['id'], string][] = [
    ['needs-you', 'Needs you'],
    ['working', 'Working'],
    ['pinned', 'Pinned'],
    ['recent', 'Recent'],
    ['archived', 'Archived'],
  ]
  return titles.flatMap(([id, title]) =>
    shelves[id].length === 0 || (id === 'archived' && !filter.archived)
      ? []
      : [{ id, title, rows: shelves[id] }],
  )
}
