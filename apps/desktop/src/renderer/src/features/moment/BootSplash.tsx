import { motion } from 'motion/react'
import type { Variants } from 'motion/react'
import { fadeUpVariants, transitions } from '@ari/ui/motion'

/** Per-letter stagger for the wordmark entrance (60ms apart). */
const LETTER_STAGGER_S = 0.06

/** Indeterminate progress sweep timing (PLAN §6.2 boot splash pulse). */
const PROGRESS_LOOP_S = 1.2

const LETTER_VARIANTS: Variants = {
  hidden: fadeUpVariants.hidden ?? { opacity: 0, y: 4 },
  visible: (letterIndex: number) => ({
    opacity: 1,
    y: 0,
    transition: { ...transitions.fadeUp, delay: letterIndex * LETTER_STAGGER_S },
  }),
}

export interface BootSplashProps {
  /** True once the engine connection is live; fades the splash away. */
  ready: boolean
}

/**
 * Full-screen boot splash (PLAN §6.2): staggered per-letter ARI wordmark
 * fade-in-up over an indeterminate accent sweep. Fades itself out (200ms)
 * when `ready`; the parent decides when to drop it from the tree entirely.
 */
export function BootSplash({ ready }: BootSplashProps) {
  return (
    <motion.div
      data-testid="boot-splash"
      aria-hidden={ready}
      initial={{ opacity: 1 }}
      animate={{ opacity: ready ? 0 : 1 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      style={{ pointerEvents: ready ? 'none' : 'auto' }}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 bg-bg"
    >
      <div className="flex">
        {'ARI'.split('').map((letter, index) => (
          <motion.span
            key={`${letter}-${index}`}
            variants={LETTER_VARIANTS}
            custom={index}
            initial="hidden"
            animate="visible"
            className="bg-gradient-to-b from-fg to-fg-subtle bg-clip-text text-3xl font-semibold tracking-[0.3em] text-transparent"
          >
            {letter}
          </motion.span>
        ))}
      </div>
      <div className="h-0.5 w-40 overflow-hidden rounded-full bg-surface-2">
        <motion.div
          data-testid="boot-progress"
          className="h-full bg-accent"
          initial={{ width: '0%' }}
          animate={{ width: ready ? '100%' : ['0%', '100%'] }}
          transition={
            ready ? { duration: 0 } : { duration: PROGRESS_LOOP_S, ease: 'easeOut', repeat: Infinity }
          }
        />
      </div>
    </motion.div>
  )
}
