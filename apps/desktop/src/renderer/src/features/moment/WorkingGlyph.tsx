import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { transitions } from '@ari/ui/motion'

const CHASE_DURATION_S = 1.2
/** Perimeter walk order of the 3x3 matrix; the center cell stays dim. */
const RING_ORDER = [0, 1, 2, 5, 8, 7, 6, 3]
const WORD_CYCLE_MS = 2000
const FLAVOUR_WORDS = ['forging', 'thinking', 'crafting', 'wielding']

export function formatElapsed(s: number): string {
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/**
 * Self-ticking elapsed readout ("12s", "1m 04s"): mutates its own text node
 * once a second so long turns never trigger React commits (T3/comet practice
 * for zero-rerender timers).
 */
export function ElapsedSeconds({ startedAt }: { startedAt: number }) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const tick = (): void => {
      if (ref.current === null) return
      ref.current.textContent = formatElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [startedAt])

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
    const timer = setInterval(() => {
      setWordIndex((index) => (index + 1) % FLAVOUR_WORDS.length)
    }, WORD_CYCLE_MS)
    return () => clearInterval(timer)
  }, [label])

  const word = label ?? FLAVOUR_WORDS[wordIndex] ?? FLAVOUR_WORDS[0]!

  return (
    <span role="status" className="inline-flex items-center gap-2">
      <span className="grid grid-cols-3 gap-0.5" aria-hidden="true">
        {Array.from({ length: 9 }, (_, cell) => {
          const ringPosition = RING_ORDER.indexOf(cell)
          const chasing = ringPosition >= 0
          return (
            <motion.span
              key={cell}
              className="size-1 rounded-[1px] bg-accent"
              animate={{ opacity: chasing ? [0.2, 1, 0.2] : 0.25 }}
              transition={
                chasing
                  ? {
                      duration: CHASE_DURATION_S,
                      ease: 'linear',
                      repeat: Infinity,
                      delay: ringPosition * (CHASE_DURATION_S / RING_ORDER.length),
                    }
                  : undefined
              }
            />
          )
        })}
      </span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={word}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={transitions.morph}
          className="text-xs text-fg-subtle"
        >
          {word}…
        </motion.span>
      </AnimatePresence>
      {startedAt != null ? <ElapsedSeconds startedAt={startedAt} /> : null}
    </span>
  )
}
