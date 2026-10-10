import type { DelegatedChild, DelegationRow, TranscriptRow } from './types'

/** The message a row belongs to and the first part it covers, read off its key. */
function rowPosition(row: TranscriptRow): { messageId: string; partIndex: number } | null {
  if (row.kind === 'turn-diff' || row.kind === 'delegation') return null
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

const STATE_ORDER = ['needs-you', 'working', 'waiting', 'failed', 'stopped', 'done', 'idle', 'removed']
const STATE_PHRASE: Record<string, string> = {
  'needs-you': 'needs you',
  working: 'working',
  waiting: 'waiting',
  failed: 'failed',
  stopped: 'stopped',
  done: 'done',
  idle: 'idle',
  removed: 'removed',
}

/** `2 working · 1 done`, most urgent first. */
export function summarizeDelegation(children: readonly DelegatedChild[]): string {
  return STATE_ORDER.flatMap((state) => {
    const count = children.filter((child) => child.state === state).length
    return count > 0 ? [`${count} ${STATE_PHRASE[state]}`] : []
  }).join(' · ')
}
