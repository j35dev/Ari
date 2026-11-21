import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { useOverlayRef } from '@ari/ui/overlay-registry'
import { Button } from '@ari/ui/button'
import { EASE_GLIDE } from '@ari/ui/motion'
import { Titlebar } from '../../shell/Titlebar'
import { DitherScene } from '../scene/DitherScene'
import { useCalm } from './onboarding-motion'

/** The steps the progress bars count; Welcome and Launch sit outside them. */
export const PROGRESS_STEPS = ['Agent', 'Projects', 'Look'] as const

/** Setup titles: the step heading in the wizard, the state heading in the gate. */
export const ONBOARDING_TITLE_CLASS =
  'text-[24px] font-semibold leading-8 tracking-[-0.02em] text-fg outline-none'

/** The one line under a step title. */
export const ONBOARDING_LEAD_CLASS = 'mt-1.5 text-[13.5px] leading-5 text-fg-muted'

/**
 * Full-window setup: the window chrome with the scene behind one centred
 * stage. Everything to read sits on the stage, so the art never carries text.
 */
export function OnboardingFrame({
  children,
  progress = null,
  brand = true,
  busy = false,
  onDismiss,
  dismissLabel,
}: {
  children: ReactNode
  /** Index into {@link PROGRESS_STEPS}; null hides the bars. */
  progress?: number | null
  /** The small wordmark; Welcome draws its own, larger. */
  brand?: boolean
  busy?: boolean
  onDismiss?: () => void
  dismissLabel?: string
}) {
  const overlayRef = useOverlayRef()
  const calm = useCalm()
  return (
    <div ref={overlayRef} className="ari-wallpaper-pane flex h-full flex-col bg-surface-0">
      <Titlebar minimal />
      <main aria-label="Ari setup" className="relative min-h-0 flex-1">
        <DitherScene kind="session" />
        {/* After the scene in the DOM, so the stage paints over it without a
            z-index. The spacers sit the stage a little above the middle. */}
        <div className="ari-scroll relative flex h-full flex-col overflow-y-auto px-6">
          <div className="min-h-4 flex-[2]" aria-hidden="true" />
          <div className="ari-stage ari-onboarding-stage mx-auto w-full max-w-[560px] shrink-0 px-8 pb-6 pt-7">
            <header className="mb-6 flex min-h-7 items-center gap-3">
              {brand && (
                <span className="text-[15px] font-semibold tracking-[-0.02em] text-fg">
                  Ari<span className="text-accent">.</span>
                </span>
              )}
              <div className="ml-auto flex items-center gap-3">
                {progress !== null && (
                  <ol
                    aria-label={`Setup progress: step ${progress + 1} of ${PROGRESS_STEPS.length}, ${PROGRESS_STEPS[progress]}`}
                    className="flex items-center gap-1"
                  >
                    {PROGRESS_STEPS.map((label, index) => (
                      <li
                        key={label}
                        aria-current={index === progress ? 'step' : undefined}
                        className="relative h-[3px] w-[22px] overflow-hidden rounded-full bg-fg/16"
                      >
                        {index < progress && (
                          <span aria-hidden="true" className="absolute inset-0 bg-fg/55" />
                        )}
                        {index === progress && (
                          <motion.span
                            aria-hidden="true"
                            layoutId="onboarding-progress"
                            className="absolute inset-0 rounded-full bg-fg"
                            transition={
                              calm ? { duration: 0 } : { duration: 0.32, ease: EASE_GLIDE }
                            }
                          />
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                {onDismiss && dismissLabel && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={onDismiss}>
                    {dismissLabel}
                  </Button>
                )}
              </div>
            </header>
            <section className="relative min-w-0">{children}</section>
          </div>
          <div className="min-h-6 flex-[3]" aria-hidden="true" />
        </div>
      </main>
    </div>
  )
}
