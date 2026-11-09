import { isHelmSession } from '@ari/contracts/helm'
import type { Session } from '@ari/contracts/session'
import type { SessionSummary } from '@ari/contracts/rpc'
import type { SessionActivity } from '../session/session-activity'
import { descendantIds } from '../session/session-tree'

type AttributedSession = Pick<Session, 'parentSessionId' | 'createdBy'>

export function startedByAria(session: AttributedSession): boolean {
  // Only Aria creates top-level sessions with a session creator. Attribution
  // survives deleting that chat, so ongoing work keeps its identity.
  return !session.parentSessionId && session.createdBy?.kind === 'session'
}

export function ariaActivity(
  sessions: readonly (SessionSummary & Pick<Session, 'createdBy'>)[],
  activityOf: (id: string) => SessionActivity | undefined,
  attentionCountOf: (id: string) => number = () => 0,
): { state: 'idle' | 'thinking' | 'working' | 'attention'; attention: number; working: number } {
  const live = sessions.filter((session) => !session.archived)
  const attention = live.reduce(
    (total, session) =>
      total +
      Math.max(attentionCountOf(session.id), activityOf(session.id)?.phase === 'paused' ? 1 : 0),
    0,
  )
  const thinking = live.some(
    (session) => isHelmSession(session) && activityOf(session.id)?.phase === 'working',
  )
  const working = live.filter(
    (session) =>
      startedByAria(session) &&
      [session.id, ...descendantIds(live, session.id)].some(
        (id) => activityOf(id)?.phase === 'working',
      ),
  ).length
  return {
    attention,
    working,
    state: attention > 0 ? 'attention' : thinking ? 'thinking' : working > 0 ? 'working' : 'idle',
  }
}
