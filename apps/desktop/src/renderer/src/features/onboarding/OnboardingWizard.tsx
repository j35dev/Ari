import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { DriverKind } from '@ari/contracts/common'
import type { DiscoveredProject } from '@ari/contracts/project'
import type { Settings } from '@ari/contracts/settings'
import { useTheme } from '@ari/ui/theme-provider'
import { useEngineSettings } from '../settings/useEngineSettings'
import { agentName, usableAgents } from './agent-catalog'
import { OnboardingAgents, type AgentsView } from './OnboardingAgents'
import { OnboardingAriCore, type AriCoreConnection } from './OnboardingAriCore'
import { OnboardingFrame } from './OnboardingFrame'
import { LAUNCH_BEAT_S, OnboardingLaunch } from './OnboardingLaunch'
import { OnboardingProjects } from './OnboardingProjects'
import { OnboardingTheme, themeLabel } from './OnboardingTheme'
import { OnboardingWelcome } from './OnboardingWelcome'
import {
  createOnboardingCompletion,
  type OnboardingChoice,
  type OnboardingFailure,
  type OnboardingOutcome,
} from './onboarding-completion'
import { stepVariants, useCalm } from './onboarding-motion'
import { useAgentSetup } from './use-agent-setup'

export type OnboardingStep = 'welcome' | 'agents' | 'core' | 'projects' | 'theme' | 'launch'

const ORDER: readonly OnboardingStep[] = ['welcome', 'agents', 'projects', 'theme', 'launch']
const PROGRESS: Partial<Record<OnboardingStep, number>> = {
  agents: 0,
  core: 0,
  projects: 1,
  theme: 2,
}

/** Keys typed here belong to the control, not to the wizard's Enter/Esc. */
function ownsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.xterm')) return true
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement)
    return key === 'Enter'
  return key === 'Enter' && (target instanceof HTMLButtonElement || target.closest('a') !== null)
}

export interface OnboardingFinish {
  /** Zoom the stage into the workspace; false lands there plainly. */
  animate: boolean
}

/**
 * Welcome, agent, projects, look, launch. Every step is optional, saves are
 * retryable, Skip never discards existing work, and Enter/Esc move forward
 * and back.
 */
export function OnboardingWizard({
  settings,
  returning,
  createFirstSession = !returning,
  onFinished,
  onLeave,
  initialStep = 'welcome',
}: {
  settings: Settings
  returning: boolean
  /** A resumed setup may already have created its first session before a failed save. */
  createFirstSession?: boolean
  onFinished: (outcome: OnboardingOutcome, finish: OnboardingFinish) => void
  onLeave: () => void
  /** For tests and previews. */
  initialStep?: OnboardingStep
}) {
  const { update } = useEngineSettings()
  const { mode } = useTheme()
  const calm = useCalm()
  const setup = useAgentSetup()
  const [finish] = useState(() => createOnboardingCompletion(update))
  const [step, setStep] = useState<OnboardingStep>(initialStep)
  const [direction, setDirection] = useState(1)
  const [agentsView, setAgentsView] = useState<AgentsView | null>(null)
  const [core, setCore] = useState<AriCoreConnection | null>(null)
  const [choice, setChoice] = useState<OnboardingChoice>(() => ({
    projects: [],
    driverKind: null,
    permissionMode: settings.sessions.defaultPermissionMode,
    createSession: createFirstSession,
  }))
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<OnboardingFailure | null>(null)
  const [attempted, setAttempted] = useState(false)
  const [skipped, setSkipped] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const lastAttempt = useRef(choice)
  const userChose = useRef(false)
  const primary = useRef<HTMLButtonElement | null>(null)
  const handoff = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      controller.current?.abort()
      if (handoff.current) clearTimeout(handoff.current)
    },
    [],
  )

  // The agent view is decided once, from the first detection: a list when
  // something is installed, "get an agent" when nothing is.
  useEffect(() => {
    if (agentsView !== null || setup.detections === null) return
    setAgentsView(usableAgents(setup.detections).length > 0 ? 'list' : 'get')
  }, [agentsView, setup.detections])

  // The best ready agent is chosen for the user until they choose themselves.
  const { detections, isReady } = setup
  useEffect(() => {
    if (userChose.current || detections === null) return
    const agents = usableAgents(detections)
    const ready = agents.filter((d) => isReady(d.kind))
    const saved = settings.sessions.defaultDriverKind
    const pick =
      ready.find((d) => d.kind === saved)?.kind ??
      ready[0]?.kind ??
      (agentsView === 'list' ? agents[0]?.kind : undefined)
    if (pick !== undefined)
      setChoice((prev) =>
        prev.driverKind === pick ? prev : { ...prev, driverKind: pick as DriverKind },
      )
  }, [detections, isReady, agentsView, settings.sessions.defaultDriverKind])

  const go = useCallback(
    (next: OnboardingStep) => {
      const rank = (value: OnboardingStep) => ORDER.indexOf(value === 'core' ? 'agents' : value)
      setDirection(rank(next) > rank(step) || (next === 'core' && step === 'agents') ? 1 : -1)
      setStep(next)
    },
    [step],
  )

  const items = (): string[] => {
    const lines: string[] = []
    if (choice.driverKind === 'ari-core' && core) lines.push(`Ari Core connected to ${core.name}`)
    else if (choice.driverKind !== null)
      lines.push(
        isReady(choice.driverKind)
          ? `${agentName(choice.driverKind)} is ready`
          : `${agentName(choice.driverKind)} is your agent`,
      )
    const count = choice.projects.length
    if (count > 0) lines.push(`${count} project${count === 1 ? '' : 's'} added`)
    lines.push(`${themeLabel(mode)} theme`)
    return lines
  }

  const complete = async (next: OnboardingChoice, animate: boolean): Promise<void> => {
    if (controller.current && !controller.current.signal.aborted) return
    const operation = new AbortController()
    controller.current = operation
    lastAttempt.current = next
    setSaving(true)
    setAttempted(true)
    setFailure(null)
    const startedAt = Date.now()
    const result = await finish(next, operation.signal)
    if (operation.signal.aborted) return
    controller.current = null
    setSaving(false)
    if (!result.ok) {
      setFailure(result.error)
      return
    }
    const outcome = result.value
    const somethingSetUp = next.driverKind !== null || next.projects.length > 0
    if (!animate || calm || !somethingSetUp) {
      onFinished(outcome, { animate: false })
      return
    }
    // Let the checklist land, then zoom into the workspace. Saving is already done.
    const beats = (items().length * LAUNCH_BEAT_S + 0.9) * 1000
    handoff.current = setTimeout(
      () => onFinished(outcome, { animate: true }),
      Math.max(0, beats - (Date.now() - startedAt)),
    )
  }

  const launch = (): void => {
    go('launch')
    void complete(choice, true)
  }

  const skip = (): void => {
    if (returning || attempted) {
      onLeave()
      return
    }
    const nothing = { ...choice, projects: [], driverKind: null, createSession: false }
    setChoice(nothing)
    setSkipped(true)
    go('launch')
    void complete(nothing, false)
  }

  const back = useCallback((): void => {
    if (attempted) return
    if (step === 'core') go('agents')
    else if (step === 'agents') go('welcome')
    else if (step === 'projects') go('agents')
    else if (step === 'theme') go('projects')
  }, [attempted, go, step])

  // Enter continues and Esc goes back, unless the focused control wants the key.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return
      if (event.key !== 'Enter' && event.key !== 'Escape') return
      if (ownsKey(event.target, event.key)) return
      if (event.key === 'Escape') {
        if (step === 'welcome' || step === 'launch' || setup.busy) return
        event.preventDefault()
        back()
        return
      }
      const button = primary.current
      if (button?.isConnected && !button.disabled) {
        event.preventDefault()
        button.click()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [back, step, setup.busy])

  // Each step's heading takes focus as it arrives, so screen readers announce it.
  const headingRef = useCallback((node: HTMLHeadingElement | null) => {
    node?.focus({ preventScroll: true })
  }, [])
  const primaryRef = useCallback((node: HTMLButtonElement | null) => {
    if (node) primary.current = node
  }, [])

  const select = useCallback((driverKind: DriverKind) => {
    userChose.current = true
    setChoice((prev) => ({ ...prev, driverKind }))
  }, [])
  const setProjects = useCallback((projects: DiscoveredProject[]) => {
    setChoice((prev) => ({ ...prev, projects }))
  }, [])

  const view = agentsView ?? 'list'
  const locked = saving || setup.busy
  return (
    <OnboardingFrame
      progress={PROGRESS[step] ?? null}
      brand={step !== 'welcome'}
      busy={locked}
      {...(step === 'launch' && !failure
        ? {}
        : {
            onDismiss: skip,
            dismissLabel: returning || attempted ? 'Back to workspace' : 'Skip',
          })}
    >
      <AnimatePresence initial={false} mode="popLayout" custom={direction}>
        <motion.div
          key={step === 'agents' ? `agents-${view}` : step}
          custom={direction}
          variants={stepVariants}
          initial="enter"
          animate="center"
          exit="exit"
          className="w-full"
        >
          {step === 'welcome' && (
            <div>
              <OnboardingWelcome
                detections={setup.detections}
                scanning={setup.scanning}
                headingRef={headingRef}
              />
              <div className="mt-6 flex justify-center">
                <button
                  ref={primaryRef}
                  type="button"
                  data-onboarding-primary=""
                  onClick={() => go('agents')}
                  className="ari-onboarding-start inline-flex h-9 items-center rounded-lg bg-fg px-5 text-[13.5px] font-medium text-bg transition-[background-color,transform] duration-150 hover:bg-fg/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  Get started
                </button>
              </div>
            </div>
          )}
          {step === 'agents' && (
            <OnboardingAgents
              view={view}
              setup={setup}
              selected={choice.driverKind}
              core={core}
              onSelect={select}
              onUseCore={() => go('core')}
              onBack={() => go('welcome')}
              onContinue={() => go('projects')}
              headingRef={headingRef}
              primaryRef={primaryRef}
            />
          )}
          {step === 'core' && (
            <OnboardingAriCore
              connection={core}
              onConnected={(connection) => {
                setCore(connection)
                setAgentsView('list')
                select('ari-core')
              }}
              onBack={() => go('agents')}
              onContinue={() => go('projects')}
              headingRef={headingRef}
              primaryRef={primaryRef}
            />
          )}
          {step === 'projects' && (
            <OnboardingProjects
              selected={choice.projects}
              onChange={setProjects}
              onBack={() => go('agents')}
              onContinue={() => go('theme')}
              headingRef={headingRef}
              primaryRef={primaryRef}
            />
          )}
          {step === 'theme' && (
            <OnboardingTheme
              onBack={() => go('projects')}
              onContinue={launch}
              headingRef={headingRef}
              primaryRef={primaryRef}
            />
          )}
          {step === 'launch' && (
            <OnboardingLaunch
              items={skipped ? [] : items()}
              saving={saving}
              failure={failure}
              onRetry={() => void complete(lastAttempt.current, !skipped)}
              onWithoutFolders={() => {
                const next = {
                  ...lastAttempt.current,
                  projects: lastAttempt.current.projects.filter(
                    (p) => !failure?.failedPaths.includes(p.path),
                  ),
                }
                setChoice(next)
                void complete(next, !skipped)
              }}
              onWithoutSession={() => {
                const next = { ...lastAttempt.current, createSession: false }
                setChoice(next)
                void complete(next, !skipped)
              }}
              onLeave={onLeave}
              headingRef={headingRef}
              primaryRef={primaryRef}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </OnboardingFrame>
  )
}
