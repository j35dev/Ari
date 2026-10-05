import type { SessionActivityPhase } from '../session/session-activity'
import { leaves } from '../split/split-layout'
import type { Space } from './spaces'

/** The dot a space tab shows: busy, needs the user, or nothing in particular. */
export type SpaceStatus = 'working' | 'attention' | null

/**
 * Folds a space's live sessions into one tab mark. "Attention" — a paused
 * approval, a finished turn, an error — outranks "working", because a
 * background space quietly finishing is exactly what the badge is for; a space
 * with nothing notable on its panes gets no mark at all.
 */
export function spaceStatus(
  space: Space,
  phaseOf: (sessionId: string) => SessionActivityPhase | undefined,
): SpaceStatus {
  let working = false
  for (const leaf of leaves(space.layout.root)) {
    if (leaf.sessionId === null) continue
    const phase = phaseOf(leaf.sessionId)
    if (phase === 'paused' || phase === 'done' || phase === 'error') return 'attention'
    if (phase === 'working') working = true
  }
  return working ? 'working' : null
}
