import { memo, useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { transitions } from '@ari/ui/motion'

const starters = [
  { label: 'Explore this project', prompt: 'Explore this project and explain its architecture.' },
  { label: 'Build something', prompt: 'Help me plan and build a new feature in this project.' },
  {
    label: 'Find improvements',
    prompt: 'Review this project and suggest the most useful improvements.',
  },
]

/**
 * Moves the existing editor between the welcome canvas and its conversation
 * dock. Memoized: its `layout` animation measures the dock on every render,
 * so it renders only when its own props change.
 */
export const ComposerDock = memo(function ComposerDock({
  centered,
  canvasRef,
  reducedMotion,
  onStart,
  children,
}: {
  centered: boolean
  canvasRef: RefObject<HTMLDivElement | null>
  reducedMotion: boolean
  onStart: (prompt: string) => void
  children: ReactNode
}) {
  const dockRef = useRef<HTMLDivElement>(null)
  const [lift, setLift] = useState(0)
  const [measured, setMeasured] = useState(false)
  const prefersReducedMotion = useReducedMotion()
  const instant = reducedMotion || prefersReducedMotion === true

  useEffect(() => {
    const canvas = canvasRef.current
    const dock = dockRef.current
    if (!canvas || !dock) return
    const measure = (): void => {
      // Layout dimensions ignore the animated transform, so retargeting never feeds back.
      setLift(Math.max(0, (canvas.clientHeight - dock.offsetHeight) / 2 - 12))
      setMeasured(true)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    observer.observe(dock)
    return () => observer.disconnect()
  }, [canvasRef])

  return (
    <motion.div
      ref={dockRef}
      className="ari-composer-dock ari-chat-column relative z-pane-chrome shrink-0"
      data-centered={centered || undefined}
      initial={false}
      layout="position"
      // Only the welcome ↔ conversation handoff moves the dock. Without this,
      // every re-render of the session view starts an app-wide layout pass
      // that re-measures every motion layout node, the sidebar's
      // drag-reorderable groups included.
      layoutDependency={centered}
      animate={{ y: centered ? -lift : 0 }}
      transition={instant || !measured ? { duration: 0 } : transitions.composerDock}
    >
      <motion.div
        className="ari-session-intro pointer-events-none absolute inset-x-0 bottom-full pb-6 text-left"
        aria-hidden={!centered}
        initial={false}
        animate={{ opacity: centered ? 1 : 0, y: centered ? 0 : -8 }}
        transition={instant ? { duration: 0 } : transitions.fadeUp}
      >
        <p className="mb-3 text-sm font-medium text-accent">
          Ari <span className="font-normal text-fg-muted">/ New session</span>
        </p>
        <h2 className="ari-session-heading font-medium text-fg">Make room for your next idea.</h2>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          Ask a question, explore your code, or put your agent to work.
        </p>
      </motion.div>
      {children}
      <motion.div
        className="ari-session-starters absolute inset-x-0 top-full flex flex-wrap justify-start gap-x-4 gap-y-2 pt-2"
        aria-hidden={!centered}
        inert={!centered}
        initial={false}
        animate={{ opacity: centered ? 1 : 0, y: centered ? 0 : 6 }}
        transition={instant ? { duration: 0 } : transitions.fadeUp}
      >
        {starters.map((starter) => (
          <button
            key={starter.label}
            type="button"
            onClick={() => onStart(starter.prompt)}
            className="rounded-md px-1 py-1.5 text-sm text-fg-muted transition-colors hover:bg-surface-1 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            {starter.label}
          </button>
        ))}
      </motion.div>
    </motion.div>
  )
})
