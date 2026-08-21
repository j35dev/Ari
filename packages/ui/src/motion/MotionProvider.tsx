import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'

/**
 * Wraps the app so every motion component respects the OS
 * `prefers-reduced-motion` setting automatically.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}
