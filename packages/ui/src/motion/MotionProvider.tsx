import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'

/**
 * Wraps the app so every motion component respects the OS
 * `prefers-reduced-motion` setting automatically.
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
