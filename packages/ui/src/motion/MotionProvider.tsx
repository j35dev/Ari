import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'

/**
 * Wraps the app so every motion component respects reduced motion: always
 * when the in-app switch is on, otherwise whenever the OS
 * `prefers-reduced-motion` setting asks for it.
 */
export function MotionProvider({
  children,
  reducedMotion = false,
}: {
  children: ReactNode
  reducedMotion?: boolean
}) {
  return <MotionConfig reducedMotion={reducedMotion ? 'always' : 'user'}>{children}</MotionConfig>
}
