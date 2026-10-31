import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import type { Settings } from '@ari/contracts/settings'
import { Button } from '@ari/ui/button'
import { useEngineSettings } from '../settings/useEngineSettings'
import { OnboardingAgents } from './OnboardingAgents'
import { OnboardingFrame } from './OnboardingFrame'
import { OnboardingProjects } from './OnboardingProjects'
import { OnboardingReady } from './OnboardingReady'
import {
  createOnboardingCompletion,
  type OnboardingChoice,
  type OnboardingFailure,
  type OnboardingOutcome,
} from './onboarding-completion'

const TITLES = ['Meet your coding agents.', 'Bring your projects along.', 'Ready when you are.']

/** Three optional steps with explicit confirmation, retryable saves and a non-destructive exit. */
export function OnboardingWizard({
  settings,
  returning,
  onFinished,
  onLeave,
}: {
  settings: Settings
  returning: boolean
  onFinished: (outcome: OnboardingOutcome) => void
  onLeave: () => void
}) {
  const { update } = useEngineSettings()
  const [finish] = useState(() => createOnboardingCompletion(update))
  const [step, setStep] = useState(0)
  const [choice, setChoice] = useState<OnboardingChoice>(() => ({
    projects: [],
    driverKind: settings.sessions.defaultDriverKind,
    permissionMode: settings.sessions.defaultPermissionMode,
    createSession: !returning,
  }))
  const [agentBusy, setAgentBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<OnboardingFailure | null>(null)
  const [attempted, setAttempted] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const lastAttempt = useRef(choice)
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [step])
  const complete = async (next: OnboardingChoice): Promise<void> => {
    if (controller.current && !controller.current.signal.aborted) return
    const operation = new AbortController()
    controller.current = operation
    lastAttempt.current = next
    setSaving(true)
    setAttempted(true)
    setFailure(null)
    const result = await finish(next, operation.signal)
    if (operation.signal.aborted) return
    controller.current = null
    setSaving(false)
    if (result.ok) onFinished(result.value)
    else setFailure(result.error)
  }
  const busy = agentBusy || saving
  const skip = (): void => {
    if (returning || attempted) onLeave()
    else {
      const skipped = { ...choice, projects: [], driverKind: null, createSession: false }
      setChoice(skipped)
      setStep(2)
      void complete(skipped)
    }
  }
  return (
    <OnboardingFrame
      step={step}
      onStep={setStep}
      busy={busy}
      navigationLocked={attempted}
      onDismiss={skip}
      dismissLabel={returning || attempted ? 'Back to workspace' : 'Skip setup'}
    >
      <div className="ari-enter-rise" key={step}>
        <p className="mb-2 font-mono text-2xs text-fg-subtle">SETUP / 0{step + 1}</p>
        <h2
          ref={heading}
          tabIndex={-1}
          className="mb-6 text-2xl font-semibold tracking-tight text-fg outline-none"
        >
          {TITLES[step]}
        </h2>
        {step === 0 && (
          <OnboardingAgents
            selected={choice.driverKind}
            onSelect={(driverKind) => setChoice((prev) => ({ ...prev, driverKind }))}
            onBusyChange={setAgentBusy}
          />
        )}
        {step === 1 && (
          <OnboardingProjects
            selected={[...choice.projects]}
            onChange={(projects) => setChoice((prev) => ({ ...prev, projects }))}
          />
        )}
        {step === 2 && (
          <OnboardingReady
            choice={choice}
            disabled={busy || attempted}
            onCreateSessionChange={(createSession) =>
              setChoice((prev) => ({ ...prev, createSession }))
            }
          />
        )}
      </div>
      {failure && (
        <div className="mt-5 space-y-3 rounded-lg border border-danger/30 bg-danger-subtle p-4">
          <p role="alert" className="text-xs leading-relaxed text-danger">
            {failure.message}
          </p>
          {failure.stage === 'projects' && (
            <Button
              size="sm"
              disabled={saving}
              onClick={() => {
                const next = {
                  ...lastAttempt.current,
                  projects: lastAttempt.current.projects.filter(
                    (p) => !failure.failedPaths.includes(p.path),
                  ),
                }
                setChoice(next)
                void complete(next)
              }}
            >
              Continue without these folders
            </Button>
          )}
          {failure.stage === 'session' && (
            <Button
              size="sm"
              disabled={saving}
              onClick={() => {
                const next = { ...lastAttempt.current, createSession: false }
                setChoice(next)
                void complete(next)
              }}
            >
              Continue without a session
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={saving} onClick={onLeave}>
            Leave setup for now
          </Button>
        </div>
      )}
      <div className="mt-7 flex items-center justify-between gap-3 border-t border-border/60 pt-5">
        <Button
          variant="ghost"
          disabled={step === 0 || busy || attempted}
          onClick={() => setStep((prev) => prev - 1)}
        >
          <ArrowLeft size={14} aria-hidden /> Back
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            if (failure) void complete(lastAttempt.current)
            else if (step < 2) setStep((prev) => prev + 1)
            else void complete(choice)
          }}
        >
          {saving ? 'Setting up…' : failure ? 'Retry' : step === 2 ? 'Open workspace' : 'Continue'}
          {!saving && <ArrowRight size={14} aria-hidden />}
        </Button>
      </div>
    </OnboardingFrame>
  )
}
