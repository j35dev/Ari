import { motion } from 'motion/react'
import { transitions } from '@ari/ui/motion'
import {
  ACTIVITY_LABEL,
  type SessionActivity,
  type SessionActivityPhase,
} from '../session/session-activity'
import './session-activity.css'

/** Perimeter walk of the 3x3 matrix; center cell stays dim (PLAN §6.2). */
const RING_ORDER = [0, 1, 2, 5, 8, 7, 6, 3]
const CHASE_DURATION_S = 1.2
/** Check lock-in: bottom-left → center → top-right. */
const DONE_CELLS = new Set([6, 4, 2])
/** X lock-in on failure. */
const ERROR_CELLS = new Set([0, 2, 4, 6, 8])
/** Vertical pause bars occupy the left and right columns. */
const PAUSE_CELLS = new Set([0, 3, 6, 2, 5, 8])

const TONE: Record<SessionActivityPhase, string> = {
  working: 'bg-busy',
  paused: 'bg-warning',
  done: 'bg-success',
  error: 'bg-danger',
}

export interface SessionActivityMarkProps {
  activity: SessionActivity
}

/**
 * Sidebar-scale signature mark: the same 3x3 forging matrix as WorkingGlyph,
 * compacted to a 10px slot so session rows do not jump. Working chases the
 * ring in the busy token (composer stop), pause holds two bars in warning,
 * settle locks a success check (or a danger X) then lingers.
 */
export function SessionActivityMark({ activity }: SessionActivityMarkProps) {
  const label = ACTIVITY_LABEL[activity.phase]
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="flex size-2.5 shrink-0 items-center justify-center"
    >
      {activity.phase === 'paused' ? <PauseBars /> : <Matrix phase={activity.phase} />}
    </span>
  )
}

function Matrix({ phase }: { phase: Exclude<SessionActivityPhase, 'paused'> }) {
  const tone = TONE[phase]
  return (
    <span className="grid grid-cols-3 gap-px" aria-hidden="true">
      {Array.from({ length: 9 }, (_, cell) => (
        <Cell key={cell} cell={cell} phase={phase} tone={tone} />
      ))}
    </span>
  )
}

function Cell({
  cell,
  phase,
  tone,
}: {
  cell: number
  phase: Exclude<SessionActivityPhase, 'paused'>
  tone: string
}) {
  if (phase === 'working') {
    const ringPosition = RING_ORDER.indexOf(cell)
    const chasing = ringPosition >= 0
    return (
      <span
        className={`size-[2px] rounded-[0.5px] ${tone} ${chasing ? 'ari-forge-cell' : 'opacity-25'}`}
        style={
          chasing ? { animationDelay: `${ringPosition * (CHASE_DURATION_S / RING_ORDER.length)}s` } : undefined
        }
      />
    )
  }

  const lit = phase === 'done' ? DONE_CELLS.has(cell) : ERROR_CELLS.has(cell)
  const order = phase === 'done' ? [6, 4, 2].indexOf(cell) : [0, 2, 4, 6, 8].indexOf(cell)
  return (
    <motion.span
      className={`size-[2px] rounded-[0.5px] ${tone}`}
      initial={{ opacity: 0.12, scale: 0.6 }}
      animate={{ opacity: lit ? 1 : 0.12, scale: lit ? 1 : 0.6 }}
      transition={{
        ...transitions.morph,
        delay: order >= 0 ? order * 0.05 : 0,
      }}
    />
  )
}

function PauseBars() {
  return (
    <span className="grid grid-cols-3 gap-px" aria-hidden="true">
      {Array.from({ length: 9 }, (_, cell) => (
        <span
          key={cell}
          className={`size-[2px] rounded-[0.5px] bg-warning ${
            PAUSE_CELLS.has(cell) ? 'ari-pause-hold' : 'opacity-0'
          }`}
        />
      ))}
    </span>
  )
}
