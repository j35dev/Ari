import { useEffect, useRef, useState } from 'react'
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

/** Moves the existing editor between the welcome canvas and its conversation dock. */
export function ComposerDock({
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
      className="ari-composer-dock relative z-10 mx-auto w-full max-w-3xl shrink-0"
      data-centered={centered || undefined}
      initial={false}
      layout="position"
      animate={{ y: centered ? -lift : 0 }}
      transition={instant || !measured ? { duration: 0 } : transitions.composerDock}
    >
      <motion.div
        className="ari-session-intro pointer-events-none absolute inset-x-4 bottom-full pb-5 text-center"
        aria-hidden={!centered}
        initial={false}
        animate={{ opacity: centered ? 1 : 0, y: centered ? 0 : -8 }}
        transition={instant ? { duration: 0 } : transitions.fadeUp}
      >
        <p className="mb-2 text-2xs font-medium tracking-[0.2em] text-accent">A R I</p>
        <h2 className="text-2xl font-medium tracking-tight text-fg">What are we building?</h2>
        <p className="mt-2 text-sm text-fg-muted">A fresh canvas for your next idea.</p>
      </motion.div>
      {children}
      <motion.div
        className="ari-session-starters absolute inset-x-4 top-full flex flex-wrap justify-center gap-2 pt-1"
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
            className="rounded-full border border-border bg-surface-1/90 px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            {starter.label}
          </button>
        ))}
      </motion.div>
    </motion.div>
  )
}
