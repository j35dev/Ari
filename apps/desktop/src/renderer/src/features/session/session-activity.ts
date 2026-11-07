/**
 * Live per-session activity for the sidebar. Derived only from in-process
 * `session.events` — never from the journal sidecar — so a crash cannot leave
 * a row spinning after the turn is gone (same rule as RunningTurnCounter).
 */

export type SessionActivityPhase = 'queued' | 'working' | 'paused' | 'done' | 'error'

export interface SessionActivity {
  phase: SessionActivityPhase
  /** Turn start epoch-ms while working/paused; null while queued or after settle. */
  startedAt: number | null
  pauseReason?: 'approval' | 'input'
  settledAt?: number
  /** Outstanding messages observed on the live feed; never hydrated from a journal. */
  queuedCount?: number
}

/** Subset of journal events the sidebar reducer cares about. */
export interface ActivityEvent {
  type: string
  to?: string
  stopReason?: string
  at?: number
}

/**
 * Settle lock-in for the session already on screen: the check/X plays, then
 * fades. Background sessions never take this path — their done/error badge
 * sticks until the user visits them (see `useSessionActivity`).
 */
export const ACTIVE_SETTLE_LINGER_MS = 4_200

/**
 * Fold one journal event into the row's live mark. `idle`/`settled` status
 * frames are ignored so the subsequent `turn.settled` can still play the
 * done lock-in (the engine writes status.changed then turn.settled).
 */
export function reduceSessionActivity(
  prev: SessionActivity | undefined,
  event: ActivityEvent,
  now: number,
): SessionActivity | undefined {
  const queuedCount = Math.max(
    0,
    (prev?.queuedCount ?? 0) +
      (event.type === 'message.enqueued' ? 1 : event.type === 'message.dequeued' ? -1 : 0),
  )
  let next = reduceActivityPhase(prev, event, now)
  if (next === prev && queuedCount === (prev?.queuedCount ?? 0)) return prev
  if (queuedCount > 0) {
    if (next === undefined || next.phase === 'done') next = { phase: 'queued', startedAt: null }
    return { ...next, queuedCount }
  }
  if (next?.queuedCount !== undefined) {
    next = { ...next }
    delete next.queuedCount
  }
  return next
}

function reduceActivityPhase(
  prev: SessionActivity | undefined,
  event: ActivityEvent,
  now: number,
): SessionActivity | undefined {
  switch (event.type) {
    case 'message.enqueued':
      return prev?.phase === 'working' || prev?.phase === 'paused' || prev?.phase === 'error'
        ? prev
        : { phase: 'queued', startedAt: null }

    case 'message.dequeued':
      return prev?.phase === 'queued' ? undefined : prev

    case 'turn.started':
      return { phase: 'working', startedAt: event.at ?? now }

    case 'session.status.changed': {
      if (event.to === 'queued') return { phase: 'queued', startedAt: null }
      if (event.to === 'running') {
        return { phase: 'working', startedAt: prev?.startedAt ?? event.at ?? now }
      }
      if (event.to === 'waiting-approval') {
        return { phase: 'paused', startedAt: prev?.startedAt ?? null, pauseReason: 'approval' }
      }
      if (event.to === 'waiting-input') {
        return { phase: 'paused', startedAt: prev?.startedAt ?? null, pauseReason: 'input' }
      }
      if (event.to === 'error') {
        return { phase: 'error', startedAt: null, settledAt: event.at ?? now }
      }
      if ((event.to === 'idle' || event.to === 'settled') && prev?.phase === 'queued') {
        return undefined
      }
      return prev
    }

    case 'approval.requested':
      return { phase: 'paused', startedAt: prev?.startedAt ?? null, pauseReason: 'approval' }

    case 'input.requested':
      return { phase: 'paused', startedAt: prev?.startedAt ?? null, pauseReason: 'input' }

    case 'approval.responded':
    case 'input.responded':
      if (prev?.phase === 'paused') {
        return prev.startedAt === null ? undefined : { phase: 'working', startedAt: prev.startedAt }
      }
      return prev

    case 'turn.settled': {
      if (event.stopReason === 'completed') {
        return { phase: 'done', startedAt: null, settledAt: event.at ?? now }
      }
      if (event.stopReason === 'error') {
        return { phase: 'error', startedAt: null, settledAt: event.at ?? now }
      }
      return undefined
    }

    case 'child.session.spawned':
      // A spawn is not evidence of execution: the child may be queued for capacity.
      return prev?.phase === 'done' || prev?.phase === 'error' ? undefined : prev

    case 'child.session.settled': {
      if (prev?.phase === 'working' || prev?.phase === 'paused' || prev?.phase === 'queued')
        return prev
      if (event.stopReason === 'error') {
        return { phase: 'error', startedAt: null, settledAt: event.at ?? now }
      }
      return { phase: 'done', startedAt: null, settledAt: event.at ?? now }
    }

    case 'child.session.destroyed':
      return prev?.phase === 'working' || prev?.phase === 'paused' || prev?.phase === 'queued'
        ? prev
        : undefined

    default:
      return prev
  }
}

/**
 * What a parent's row shows once its delegated work is taken into account. A
 * child waiting on the user holds the whole tree up, so that wins. Otherwise
 * the parent's own live turn shows, and a parent that ended its turn while
 * children still run reads as working, not done: it will be woken with their
 * results.
 */
export function treeActivity(
  own: SessionActivity | undefined,
  descendants: Array<SessionActivity | undefined>,
): SessionActivity | undefined {
  const blocked = descendants.find((activity) => activity?.phase === 'paused')
  if (blocked) return blocked
  if (own?.phase === 'working' || own?.phase === 'paused') return own
  return (
    descendants.find((activity) => activity?.phase === 'working') ??
    (own?.phase === 'queued'
      ? own
      : descendants.find((activity) => activity?.phase === 'queued')) ??
    own
  )
}

/** Decisions outrank execution in a project, including when its rows are collapsed. */
export function peakActivity(
  activities: Array<SessionActivity | undefined>,
): SessionActivity | undefined {
  let working: SessionActivity | undefined
  let queued: SessionActivity | undefined
  let error: SessionActivity | undefined
  let done: SessionActivity | undefined
  for (const activity of activities) {
    if (activity === undefined) continue
    if (activity.phase === 'paused') return activity
    if (activity.phase === 'working' && working === undefined) working = activity
    else if (activity.phase === 'queued' && queued === undefined) queued = activity
    else if (activity.phase === 'error' && error === undefined) error = activity
    else if (activity.phase === 'done' && done === undefined) done = activity
  }
  return working ?? queued ?? error ?? done
}

export const ACTIVITY_LABEL: Record<SessionActivityPhase, string> = {
  queued: 'Queued',
  working: 'Working',
  paused: 'Waiting for you',
  done: 'Turn complete',
  error: 'Turn failed',
}
