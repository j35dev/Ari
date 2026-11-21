import type { Ref } from 'react'
import { motion } from 'motion/react'
import { Button } from '@ari/ui/button'
import { ONBOARDING_LEAD_CLASS, ONBOARDING_TITLE_CLASS } from './OnboardingFrame'
import type { OnboardingFailure } from './onboarding-completion'
import { DrawnCheck, listItem, staggerList, useCalm } from './onboarding-motion'

/** Each line's beat in the checklist; the hand-off waits for the last one. */
export const LAUNCH_BEAT_S = 0.26

/**
 * The last frame: what setup did, one checked line at a time, while it saves.
 * Saving starts the moment this frame appears; the lines never hold it back.
 */
export function OnboardingLaunch({
  items,
  saving,
  failure,
  onRetry,
  onWithoutFolders,
  onWithoutSession,
  onLeave,
  headingRef,
  primaryRef,
}: {
  items: readonly string[]
  saving: boolean
  failure: OnboardingFailure | null
  onRetry: () => void
  onWithoutFolders: () => void
  onWithoutSession: () => void
  onLeave: () => void
  headingRef: Ref<HTMLHeadingElement>
  primaryRef: Ref<HTMLButtonElement>
}) {
  const calm = useCalm()
  return (
    <div className="pb-2 pt-2">
      <h2 ref={headingRef} tabIndex={-1} className={ONBOARDING_TITLE_CLASS}>
        {failure
          ? 'Almost there'
          : items.length === 0
            ? 'Opening your workspace'
            : 'You’re all set'}
      </h2>
      <p className={ONBOARDING_LEAD_CLASS}>
        {failure
          ? 'One part of setup didn’t save. Everything else is kept.'
          : items.length === 0
            ? 'Nothing was changed. Run setup again anytime from Settings.'
            : saving
              ? 'Saving your setup…'
              : 'Opening your workspace…'}
      </p>
      <motion.ul
        aria-label="What was set up"
        className="mt-5 flex flex-col gap-2.5"
        variants={staggerList(LAUNCH_BEAT_S, 0.08)}
        initial={calm ? false : 'hidden'}
        animate="shown"
      >
        {items.map((item, index) => (
          <motion.li
            key={item}
            variants={listItem}
            className="flex items-center gap-2.5 text-[14px] text-fg"
          >
            <DrawnCheck size={16} delay={calm ? 0 : 0.12 + index * LAUNCH_BEAT_S} />
            {item}
          </motion.li>
        ))}
      </motion.ul>
      {failure && (
        <div className="mt-5 space-y-3 border-t border-border pt-4">
          <p role="alert" className="flex items-start gap-2 text-[13px] leading-5 text-fg">
            <span className="ari-status mt-[5px]" data-status="error" aria-hidden="true" />
            <span className="min-w-0 flex-1">{failure.message}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={primaryRef}
              variant="primary"
              size="sm"
              disabled={saving}
              onClick={onRetry}
            >
              Retry
            </Button>
            {failure.stage === 'projects' && (
              <Button size="sm" disabled={saving} onClick={onWithoutFolders}>
                Continue without these folders
              </Button>
            )}
            {failure.stage === 'session' && (
              <Button size="sm" disabled={saving} onClick={onWithoutSession}>
                Continue without a session
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={saving} onClick={onLeave}>
              Leave setup for now
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
