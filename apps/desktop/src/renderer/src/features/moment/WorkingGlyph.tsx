import { useEffect, useState } from 'react'
import { subscribeTick, TICK_MS, useTickingText } from './shared-clock'
import './session-activity.css'

const CHASE_DURATION_S = 1.2
/** Perimeter walk order of the 3x3 matrix; the center cell stays dim. */
const RING_ORDER = [0, 1, 2, 5, 8, 7, 6, 3]
const WORD_CYCLE_MS = 2000
const TICKS_PER_WORD = WORD_CYCLE_MS / TICK_MS
const FLAVOUR_WORDS = ['forging', 'weighing', 'shaping', 'listening']

export function formatElapsed(s: number): string {
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/**
 * Self-ticking elapsed readout ("12s", "1m 04s"): repaints its own text on the
 * shared clock so long turns never trigger React commits (T3/comet practice
 * for zero-rerender timers).
 */
export function ElapsedSeconds({ startedAt }: { startedAt: number }) {
  const ref = useTickingText<HTMLSpanElement>(
    (now) => formatElapsed(Math.max(0, Math.floor((now - startedAt) / 1000))),
    startedAt,
  )

  return (
    <span ref={ref} className="text-fg-subtle tabular-nums">
      0s
    </span>
  )
}

export interface WorkingGlyphProps {
  /** Fixed label; omit to cycle the flavour words ("forging…"). */
  label?: string
  /** Turn start epoch-ms; renders a live elapsed counter beside the word. */
  startedAt?: number | null
}

/**
 * Working indicator (PLAN §6.2): a rotating 3x3 matrix glyph chasing light
 * around its perimeter beside a flavour word that swaps every 2s, plus an
 * optional live elapsed timer when `startedAt` is given.
 */
export function WorkingGlyph({ label, startedAt }: WorkingGlyphProps) {
  const [wordIndex, setWordIndex] = useState(0)

  useEffect(() => {
    if (label !== undefined) return
    let ticks = 0
    return subscribeTick(() => {
      ticks += 1
      if (ticks % TICKS_PER_WORD === 0) {
        setWordIndex((index) => (index + 1) % FLAVOUR_WORDS.length)
      }
    })
  }, [label])

  const word = label ?? FLAVOUR_WORDS[wordIndex] ?? FLAVOUR_WORDS[0]!

  return (
    <span role="status" className="inline-flex items-center gap-2">
      {/* The chase is a compositor-only CSS loop (the sidebar mark's), so a
          long turn costs no JavaScript per frame and nothing on re-render. */}
      <span className="grid grid-cols-3 gap-0.5" aria-hidden="true">
        {Array.from({ length: 9 }, (_, cell) => {
          const ringPosition = RING_ORDER.indexOf(cell)
          return ringPosition >= 0 ? (
            <span
              key={cell}
              className="ari-forge-cell size-1 rounded-[1px] bg-accent"
              style={{
                animationDelay: `${ringPosition * (CHASE_DURATION_S / RING_ORDER.length)}s`,
              }}
            />
          ) : (
            <span key={cell} className="size-1 rounded-[1px] bg-accent opacity-25" />
          )
        })}
      </span>
      {/* Keyed so each word plays its entrance; no exit holds the next back. */}
      <span key={word} className="ari-enter-rise text-xs text-fg-subtle">
        {word}…
      </span>
      {startedAt != null ? <ElapsedSeconds startedAt={startedAt} /> : null}
    </span>
  )
}
