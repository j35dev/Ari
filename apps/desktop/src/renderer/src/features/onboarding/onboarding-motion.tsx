import { motion, useReducedMotionConfig, type Transition, type Variants } from 'motion/react'
import { EASE_GLIDE, EASE_OUT_EXPO } from '@ari/ui/motion'

/**
 * Setup's motion vocabulary, on Ari's eases. Every value here is decorative:
 * nothing waits on an animation, and under reduced motion (Ari's switch or the
 * OS preference, both read by `MotionConfig`) each one resolves instantly.
 */

/** True when the in-app switch or `prefers-reduced-motion` asks for stillness. */
export function useCalm(): boolean {
  return useReducedMotionConfig() === true
}

/** A step slides in from the side it was reached from, while the last one fades. */
export const stepVariants: Variants = {
  enter: (direction: number) => ({ opacity: 0, x: direction * 28 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.26, ease: EASE_OUT_EXPO } },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction * -20,
    transition: { duration: 0.14, ease: 'easeIn' },
  }),
}

/** Lists cascade in a beat apart. */
export function staggerList(gap = 0.05, delay = 0.04): Variants {
  return {
    hidden: {},
    shown: { transition: { staggerChildren: gap, delayChildren: delay } },
  }
}

export const listItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE_OUT_EXPO } },
}

/** Progress fills glide, so a jump between phases still reads as one motion. */
export const fill: Transition = { duration: 0.5, ease: EASE_GLIDE }

/** A check that draws its own stroke. `delay` staggers it after the row it marks. */
export function DrawnCheck({
  size = 14,
  delay = 0,
  className,
}: {
  size?: number
  delay?: number
  className?: string
}) {
  const calm = useCalm()
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={['shrink-0 text-success', className].filter(Boolean).join(' ')}
    >
      <motion.circle
        cx="8"
        cy="8"
        r="7"
        fill="currentColor"
        fillOpacity={0.14}
        stroke="none"
        initial={calm ? false : { scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.22, ease: EASE_OUT_EXPO, delay }}
        style={{ originX: '50%', originY: '50%' }}
      />
      <motion.path
        d="M4.75 8.25 7 10.5l4.25-4.75"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={calm ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.32, ease: EASE_GLIDE, delay: delay + 0.08 }}
      />
    </svg>
  )
}
