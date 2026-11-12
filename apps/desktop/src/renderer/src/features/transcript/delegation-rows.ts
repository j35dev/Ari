import type { DelegatedChild, DelegationRow, TranscriptRow } from './types'

/** The message a row belongs to and the first part it covers, read off its key. */
function rowPosition(row: TranscriptRow): { messageId: string; partIndex: number } | null {
  if (row.kind === 'turn-diff' || row.kind === 'delegation' || row.kind === 'provider-switch')
    return null
  const key = row.kind === 'tool-group' ? row.blocks[0]?.key : row.key
  if (key === undefined) return null
  const split = key.lastIndexOf('#')
  if (split === -1) return null
  const tail = key.slice(split + 1)
  const partIndex = Number.parseInt(tail.startsWith('img') ? tail.slice(3) : tail, 10)
  return Number.isNaN(partIndex) ? null : { messageId: key.slice(0, split), partIndex }
}

/**
 * Places each delegated child's card right after the row that was on screen
 * when it was spawned — the activity burst holding the spawn command — so the
 * card reads as that burst's outcome. Children spawned from the same row share
 * one group. A child whose anchor is gone (history not loaded, message
 * rewritten) lands at the end rather than disappearing.
 */
export function insertDelegationRows(
  rows: TranscriptRow[],
  children: readonly DelegatedChild[],
): TranscriptRow[] {
  if (children.length === 0) return rows
  const positions = rows.map(rowPosition)
  const groups = new Map<number, DelegatedChild[]>()
  for (const child of children) {
    let target = rows.length - 1
    for (let i = positions.length - 1; i >= 0; i--) {
      const position = positions[i]
      if (
        position &&
        position.messageId === child.anchor.messageId &&
        position.partIndex <= child.anchor.partIndex
      ) {
        target = i
        break
      }
    }
    const group = groups.get(target) ?? []
    group.push(child)
    groups.set(target, group)
  }
  const group = (index: number): DelegationRow[] => {
    const members = groups.get(index)
    const first = members?.[0]
    return members && first
      ? [{ kind: 'delegation', key: `delegation:${first.sessionId}`, children: members }]
      : []
  }
  return [...group(-1), ...rows.flatMap((row, index) => [row, ...group(index)])]
}

/** States in which a child is still doing, or waiting to do, something. */
const LIVE_STATES: ReadonlySet<string> = new Set([
  'working',
  'queued',
  'starting',
  'stopping',
  'needs-you',
  'needs-lead',
  'waiting',
  'unknown',
])

/** Whether a child is running or waiting, as opposed to finished or gone. */
export function isLiveChild(child: DelegatedChild): boolean {
  return LIVE_STATES.has(child.state)
}

/** A finished child stays in view this long after the group last did anything. */
export const RECENT_WINDOW_MS = 12 * 60 * 60 * 1000

/**
 * Splits a group into the agents worth showing now and the ones kept behind
 * "earlier": removed sessions, and work that finished long before the group's
 * latest activity. Old agents can share a group with new ones (their place in
 * the conversation is no longer loaded), and a three-day-old run should not
 * sit beside the one in progress.
 *
 * "Recent" is measured against the group, not the clock: a group that is
 * running counts from now, one that settled counts from its last settle, so
 * an old turn still shows its own agents. A child with no known time stays in
 * view. If nothing would be left, the whole group is shown.
 */
export function splitDelegation(
  children: readonly DelegatedChild[],
  now: number,
): { current: DelegatedChild[]; earlier: DelegatedChild[] } {
  const activeAt = (child: DelegatedChild): number | null =>
    isLiveChild(child) ? now : (child.settledAt ?? child.spawnedAt ?? null)
  let latest: number | null = null
  for (const child of children) {
    if (child.state === 'removed') continue
    const at = activeAt(child)
    if (at !== null && (latest === null || at > latest)) latest = at
  }
  const current: DelegatedChild[] = []
  const earlier: DelegatedChild[] = []
  for (const child of children) {
    const at = activeAt(child)
    const stale =
      child.state === 'removed' ||
      (!isLiveChild(child) && latest !== null && at !== null && latest - at > RECENT_WINDOW_MS)
    ;(stale ? earlier : current).push(child)
  }
  return current.length === 0 ? { current: [...children], earlier: [] } : { current, earlier }
}

const STATE_ORDER = [
  'needs-you',
  'needs-lead',
  'unknown',
  'queued',
  'starting',
  'stopping',
  'working',
  'waiting',
  'failed',
  'stopped',
  'done',
  'idle',
  'removed',
]
const STATE_PHRASE: Record<string, string> = {
  'needs-you': 'needs you',
  working: 'working',
  waiting: 'waiting',
  failed: 'failed',
  stopped: 'interrupted',
  done: 'results ready',
  'needs-lead': 'needs lead',
  queued: 'queued',
  starting: 'starting',
  stopping: 'stopping',
  unknown: 'activity unknown',
  idle: 'idle',
  removed: 'removed',
}

/** One phrase per state present in a group (`2 working`), most urgent first. */
export function delegationPhrases(
  children: readonly DelegatedChild[],
): Array<{ state: string; phrase: string }> {
  return STATE_ORDER.flatMap((state) => {
    const count = children.filter((child) => child.state === state).length
    return count > 0
      ? [
          {
            state,
            phrase: `${count} ${state === 'done' && count === 1 ? 'result ready' : STATE_PHRASE[state]}`,
          },
        ]
      : []
  })
}

/** `2 working · 1 done`, most urgent first. */
export function summarizeDelegation(children: readonly DelegatedChild[]): string {
  return delegationPhrases(children)
    .map(({ phrase }) => phrase)
    .join(' · ')
}
