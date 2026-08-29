/**
 * Live per-session activity for the sidebar. Derived only from in-process
 * `session.events` — never from the journal sidecar — so a crash cannot leave
 * a row spinning after the turn is gone (same rule as RunningTurnCounter).
 */

export type SessionActivityPhase = 'working' | 'paused' | 'done' | 'error'

export interface SessionActivity {
  phase: SessionActivityPhase
  /** Turn start epoch-ms while working/paused; null after settle. */
  startedAt: number | null
  pauseReason?: 'approval' | 'input'
  settledAt?: number
}

/** Subset of journal events the sidebar reducer cares about. */
export interface ActivityEvent {
  type: string
  to?: string
  stopReason?: string
  at?: number
}

/** How long the done lock-in stays on a row before fading to idle. */
export const DONE_LINGER_MS = 4_200
/** Errors linger longer so a failure in a background chat is still findable. */
export const ERROR_LINGER_MS = 8_000

export function lingerMsFor(phase: SessionActivityPhase): number | null {
  if (phase === 'done') return DONE_LINGER_MS
  if (phase === 'error') return ERROR_LINGER_MS
  return null
}

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
  switch (event.type) {
    case 'turn.started':
      return { phase: 'working', startedAt: event.at ?? now }

    case 'session.status.changed': {
      if (event.to === 'running' || event.to === 'queued') {
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
      return prev
    }

    case 'approval.requested':
      return { phase: 'paused', startedAt: prev?.startedAt ?? null, pauseReason: 'approval' }

    case 'input.requested':
      return { phase: 'paused', startedAt: prev?.startedAt ?? null, pauseReason: 'input' }

    case 'approval.responded':
    case 'input.responded':
      if (prev?.phase === 'paused') {
        return { phase: 'working', startedAt: prev.startedAt ?? now }
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

    default:
      return prev
  }
}

/** Highest-priority phase among a project's sessions (working > paused > error > done). */
export function peakActivity(
  activities: Array<SessionActivity | undefined>,
): SessionActivity | undefined {
  let paused: SessionActivity | undefined
  let error: SessionActivity | undefined
  let done: SessionActivity | undefined
  for (const activity of activities) {
    if (activity === undefined) continue
    if (activity.phase === 'working') return activity
    if (activity.phase === 'paused' && paused === undefined) paused = activity
    else if (activity.phase === 'error' && error === undefined) error = activity
    else if (activity.phase === 'done' && done === undefined) done = activity
  }
  return paused ?? error ?? done
}

export const ACTIVITY_LABEL: Record<SessionActivityPhase, string> = {
  working: 'Working',
  paused: 'Waiting for you',
  done: 'Turn complete',
  error: 'Turn failed',
}
