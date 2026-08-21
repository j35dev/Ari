/**
 * Ari motion catalog (PLAN §6.4). Named transitions and variants so every
 * surface moves identically. All consumers honor prefers-reduced-motion via
 * MotionProvider.
 */
import type { Transition, Variants } from 'motion/react'

/** cubic-bezier(0.16,1,0.3,1) — signature ease-out for entrances. */
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

/** cubic-bezier(0.22,1,0.36,1) — slides and resorts. */
export const EASE_SLIDE = [0.22, 1, 0.36, 1] as const

export const transitions = {
  /** fade-in-up: 220ms */
  fadeUp: { duration: 0.22, ease: EASE_OUT_EXPO } satisfies Transition,
  /** menu/popover-in: 140ms scale+fade */
  menuIn: { duration: 0.14, ease: EASE_OUT_EXPO } satisfies Transition,
  /** pane width/height tweens: 200ms */
  paneSlide: { duration: 0.2, ease: 'easeOut' } satisfies Transition,
  /** composer morph + icon crossfades: 180ms */
  morph: { duration: 0.18, ease: EASE_OUT_EXPO } satisfies Transition,
  /** session-resort FLIP slides: 260ms */
  resort: { duration: 0.26, ease: EASE_SLIDE } satisfies Transition,
} as const

/** Sidebar collapse/expand spring (PLAN §6.4: stiffness 320 / damping 34). */
export const sidebarSpring: Transition = { type: 'spring', stiffness: 320, damping: 34 }

export const fadeUpVariants: Variants = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: transitions.fadeUp },
}

export const menuInVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: transitions.menuIn },
  exit: { opacity: 0, scale: 0.96, transition: { duration: 0.1, ease: 'easeIn' } },
}

/** Streaming veil — paint-only opacity fade for appended transcript text. */
export const veilVariants: Variants = {
  hidden: { opacity: 0.35 },
  visible: { opacity: 1, transition: { duration: 0.24, ease: 'easeOut' } },
}
