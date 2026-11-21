import { useId, type Ref } from 'react'
import { motion } from 'motion/react'
import { EASE_OUT_EXPO } from '@ari/ui/motion'
import { ARI_MARK_FOLD_PATH, ARI_MARK_PATH, ARI_MARK_VIEWBOX } from '@ari/ui/brand/ari-mark'
import { ProviderLogo } from '../composer/provider-logo'
import { agentName, usableAgents, type Detection } from './agent-catalog'
import { DrawnCheck, listItem, staggerList, useCalm } from './onboarding-motion'

/**
 * The first frame: the mark lands while detection is already running, and
 * each agent found appears as one line with a check that draws itself.
 */
export function OnboardingWelcome({
  detections,
  scanning,
  headingRef,
}: {
  detections: readonly Detection[] | null
  scanning: boolean
  headingRef: Ref<HTMLHeadingElement>
}) {
  const calm = useCalm()
  const clipId = `ari-welcome-${useId().replace(/:/g, '')}`
  const found = usableAgents(detections)
  const settled = detections !== null && !scanning
  return (
    <div className="flex flex-col items-center pb-2 pt-4 text-center">
      <h2
        ref={headingRef}
        tabIndex={-1}
        aria-label="Welcome to Ari"
        className="flex flex-col items-center outline-none"
      >
        {/* The app icon's mark rises in, the same one the launch screen draws. */}
        <motion.svg
          aria-hidden="true"
          viewBox={`0 0 ${ARI_MARK_VIEWBOX.width} ${ARI_MARK_VIEWBOX.height}`}
          className="h-[50px] w-auto text-fg"
          initial={calm ? false : { opacity: 0, y: 14, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.6, ease: EASE_OUT_EXPO, delay: 0.04 }}
        >
          <defs>
            <clipPath id={clipId}>
              <path d={ARI_MARK_PATH} />
            </clipPath>
          </defs>
          <path d={ARI_MARK_PATH} fill="currentColor" />
          <path
            d={ARI_MARK_FOLD_PATH}
            fill="var(--ari-bg)"
            fillOpacity={0.14}
            clipPath={`url(#${clipId})`}
          />
        </motion.svg>
      </h2>
      <motion.p
        className="mt-5 text-[14px] leading-5 text-fg-muted"
        initial={calm ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.45 }}
      >
        Your coding agents and projects, in one calm workspace.
      </motion.p>
      <div className="mt-8 flex min-h-[84px] w-full flex-col items-center">
        {found.length > 0 ? (
          <motion.ul
            aria-label="Agents found on this computer"
            className="flex w-fit flex-col gap-2"
            variants={staggerList(0.16, calm ? 0 : 0.5)}
            initial={calm ? false : 'hidden'}
            animate="shown"
          >
            {found.slice(0, 4).map((detection, index) => (
              <motion.li
                key={detection.kind}
                variants={listItem}
                className="flex items-center gap-2.5 text-[13.5px] text-fg"
              >
                <DrawnCheck delay={calm ? 0 : 0.6 + index * 0.16} />
                <span className="flex size-5 items-center justify-center text-fg-muted [&>svg]:size-3.5">
                  <ProviderLogo kind={detection.kind} />
                </span>
                Found {agentName(detection.kind)}
              </motion.li>
            ))}
            {found.length > 4 && (
              <motion.li variants={listItem} className="pl-[52px] text-[13px] text-fg-subtle">
                and {found.length - 4} more
              </motion.li>
            )}
          </motion.ul>
        ) : (
          <p
            role="status"
            className="flex w-full items-center justify-center gap-2 text-[13.5px] text-fg-subtle"
          >
            {settled ? (
              'No coding agents yet. Ari will help you get one.'
            ) : (
              <>
                <span className="ari-onboarding-pulse size-1.5 rounded-full bg-fg-subtle" />
                Looking for coding agents…
              </>
            )}
          </p>
        )}
      </div>
    </div>
  )
}
