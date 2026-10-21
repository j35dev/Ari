/**
 * Ari motion catalog (PLAN §6.4). Named transitions and variants so every
 * surface moves identically. All consumers honor prefers-reduced-motion via
 * MotionProvider.
 *
 * The standard, shared with the `--ari-ease-*` / `--ari-dur-*` tokens in
 * tokens.css: animate transform and opacity only; hover and press change
 * colour within {@link durations.fast}; nothing that answers a click runs
 * longer than {@link durations.panel}; and no exit holds back the view that
 * replaces it.
 */
import type { Transition, Variants } from 'motion/react'

/** cubic-bezier(0.16,1,0.3,1) — signature ease-out for entrances. */
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

/** cubic-bezier(0.22,1,0.36,1) — panels, slides and resorts. */
export const EASE_GLIDE = [0.22, 1, 0.36, 1] as const

/** cubic-bezier(0.2,0,0,1) — small state changes that should just settle. */
export const EASE_SOFT = [0.2, 0, 0, 1] as const

/** Durations in seconds; each mirrors the `--ari-dur-*` token of the same name. */
export const durations = {
  /** Icon swaps and other tiny state changes. */
  micro: 0.1,
  /** Hover/press colour and menu entrances. */
  fast: 0.14,
  /** Panels, sheets, dialogs, the sidebar. The ceiling for anything on a click path. */
  panel: 0.18,
} as const

export const transitions = {
  /** fade-in-up for panels and cards taking their place */
  fadeUp: { duration: durations.panel, ease: EASE_OUT_EXPO } satisfies Transition,
  /** menu/popover-in: scale+fade */
  menuIn: { duration: durations.fast, ease: EASE_OUT_EXPO } satisfies Transition,
  /** menu/popover-out: quicker than the entrance so it never trails the click */
  menuOut: { duration: durations.micro, ease: 'easeIn' } satisfies Transition,
  /** icon swaps and other micro crossfades */
  micro: { duration: durations.micro, ease: EASE_SOFT } satisfies Transition,
  /** pane slides (sheets, drawers) */
  paneSlide: { duration: durations.panel, ease: EASE_GLIDE } satisfies Transition,
  /** composer morph + icon crossfades */
  morph: { duration: durations.panel, ease: EASE_OUT_EXPO } satisfies Transition,
  /** session-resort FLIP slides */
  resort: { duration: durations.panel, ease: EASE_GLIDE } satisfies Transition,
  /** Retargetable, critically damped movement without scaling the editor. */
  composerDock: {
    type: 'spring',
    visualDuration: durations.panel,
    bounce: 0,
  } satisfies Transition,
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
  exit: { opacity: 0, scale: 0.96, transition: transitions.menuOut },
}

/** Streaming veil — paint-only opacity fade for appended transcript text. */
export const veilVariants: Variants = {
  hidden: { opacity: 0.35 },
  visible: { opacity: 1, transition: { duration: 0.12, ease: 'easeOut' } },
}
