import {
  ACTIVITY_LABEL,
  type SessionActivity,
  type SessionActivityPhase,
} from '../session/session-activity'
import './session-activity.css'

/** Perimeter walk of the 3x3 matrix; center cell stays dim (PLAN §6.2). */
const RING_ORDER = [0, 1, 2, 5, 8, 7, 6, 3]
const CHASE_DURATION_S = 1.2

/** Settled and waiting phases use the shared status glyphs (styles/frame.css). */
const STATUS_GLYPH: Record<Exclude<SessionActivityPhase, 'working'>, string> = {
  queued: 'queued',
  paused: 'attention',
  done: 'done',
  error: 'error',
}

export interface SessionActivityMarkProps {
  activity: SessionActivity
}

/**
 * Row-scale status in a 14px slot, so rows do not jump as a session moves
 * between phases. Working keeps the product's pixel motif: the 3x3 forging
 * matrix chasing its ring, in muted ink rather than a status colour. Every
 * other phase is one glyph from the shared vocabulary: a dashed ring while
 * queued, the accent dot when it needs you, a grey check when done, a red dot
 * when it failed. The phase is announced through the label, never a word.
 */
export function SessionActivityMark({ activity }: SessionActivityMarkProps) {
  const label = ACTIVITY_LABEL[activity.phase]
  if (activity.phase !== 'working') {
    return (
      <span
        role="status"
        aria-label={label}
        title={label}
        className="ari-status"
        data-status={STATUS_GLYPH[activity.phase]}
      />
    )
  }
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="inline-grid size-3.5 shrink-0 place-items-center"
    >
      <span className="grid grid-cols-3 gap-px" aria-hidden="true">
        {Array.from({ length: 9 }, (_, cell) => {
          const ringPosition = RING_ORDER.indexOf(cell)
          return ringPosition >= 0 ? (
            <span
              key={cell}
              className="ari-forge-cell size-[3px] bg-fg-muted"
              style={{
                animationDelay: `${ringPosition * (CHASE_DURATION_S / RING_ORDER.length)}s`,
              }}
            />
          ) : (
            <span key={cell} className="size-[3px] bg-fg-muted opacity-25" />
          )
        })}
      </span>
    </span>
  )
}
