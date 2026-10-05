import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'
import { useReducedMotionSetting } from './reduced-motion'

/**
 * Wraps the app so every motion component respects reduced motion: always
 * when the in-app switch is on, otherwise whenever the OS
 * `prefers-reduced-motion` setting asks for it.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  const reduced = useReducedMotionSetting()
  return <MotionConfig reducedMotion={reduced ? 'always' : 'user'}>{children}</MotionConfig>
}
