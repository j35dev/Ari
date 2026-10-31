import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Settings } from '@ari/contracts/settings'
import { createLogger } from '@ari/shared/logger'
import { Button } from '@ari/ui/button'
import { Skeleton } from '@ari/ui/skeleton'
import { rpc } from '../../lib/rpc'
import { saveLastPick } from '../composer/last-pick'
import { OnboardingFrame } from './OnboardingFrame'
import { OnboardingWizard } from './OnboardingWizard'
import type { OnboardingOutcome } from './onboarding-completion'

const log = createLogger('onboarding:gate')
const LOAD_TIMEOUT_MS = 15_000

type GateState =
  | { status: 'loading' | 'error' | 'closed' }
  | { status: 'setup'; settings: Settings; returning: boolean }
export interface OnboardingWorkspaceProps {
  onOpenSetup: () => void
  setupCovered: boolean
  onboardingOutcome: OnboardingOutcome | null
}

/** Waits for authoritative boot data and keeps an established workspace mounted during re-entry. */
export function OnboardingGate({
  children,
}: {
  children: (props: OnboardingWorkspaceProps) => ReactNode
}) {
  const [state, setState] = useState<GateState>({ status: 'loading' })
  const [mounted, setMounted] = useState(false)
  const [outcome, setOutcome] = useState<OnboardingOutcome | null>(null)
  const generation = useRef(0)
  const previousFocus = useRef<HTMLElement | null>(null)
  const load = useCallback(async (returning = false) => {
    const mine = ++generation.current
    setState({ status: 'loading' })
    const timer = setTimeout(() => {
      if (mine !== generation.current) return
      generation.current++
      log.warn('workspace check timed out')
      setState({ status: 'error' })
    }, LOAD_TIMEOUT_MS)
    try {
      const [settings, projects, sessions] = await Promise.all([
        rpc.invoke('settings.get'),
        rpc.invoke('project.list'),
        rpc.invoke('session.list'),
      ])
      if (mine !== generation.current) return
      if (returning) setState({ status: 'setup', settings, returning: true })
      else if (
        settings.onboarding?.completedAt != null ||
        projects.length > 0 ||
        sessions.length > 0
      ) {
        setMounted(true)
        setState({ status: 'closed' })
        if (settings.onboarding?.completedAt == null) {
          void rpc
            .invoke('settings.update', { onboarding: { completedAt: Date.now() } })
            .catch((error: unknown) =>
              log.warn('existing workspace migration could not be saved', error),
            )
        }
      } else setState({ status: 'setup', settings, returning: false })
    } catch (error) {
      log.warn('workspace check failed', error)
      if (mine === generation.current) setState({ status: 'error' })
    } finally {
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    void load()
    return () => {
      generation.current++
    }
  }, [load])
  const leave = useCallback((result: OnboardingOutcome = { sessionId: null, driverKind: null }) => {
    generation.current++
    if (result.driverKind !== null)
      saveLastPick({ driverKind: result.driverKind, modelId: null, effort: null })
    setOutcome(result)
    setMounted(true)
    setState({ status: 'closed' })
  }, [])
  useEffect(() => {
    if (
      state.status === 'closed' &&
      outcome?.sessionId == null &&
      previousFocus.current?.isConnected
    )
      previousFocus.current.focus({ preventScroll: true })
  }, [state.status, outcome])
  const open = useCallback(() => {
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    void load(true)
  }, [load])
  const covered = state.status !== 'closed'
  return (
    <>
      {mounted && (
        <div className={covered ? 'hidden' : 'h-full'} hidden={covered} inert={covered}>
          {children({ onOpenSetup: open, setupCovered: covered, onboardingOutcome: outcome })}
        </div>
      )}
      {state.status === 'setup' ? (
        <OnboardingWizard
          settings={state.settings}
          returning={state.returning}
          onFinished={leave}
          onLeave={() => leave()}
        />
      ) : (
        covered && (
          <OnboardingFrame
            onDismiss={() => leave()}
            dismissLabel={mounted ? 'Back to workspace' : 'Open workspace for now'}
          >
            <h2 className="text-2xl font-semibold tracking-tight text-fg">
              {state.status === 'error'
                ? 'Couldn’t check your workspace.'
                : 'Getting your workspace ready.'}
            </h2>
            <p
              role={state.status === 'error' ? 'alert' : 'status'}
              className="mt-4 text-sm leading-relaxed text-fg-muted"
            >
              {state.status === 'error'
                ? 'Ari could not read your saved settings, projects or sessions. Retry, or open the workspace without marking setup complete.'
                : 'Checking saved settings, projects and sessions. Nothing is being imported.'}
            </p>
            {state.status === 'error' ? (
              <Button className="mt-6" variant="primary" onClick={() => void load(mounted)}>
                Retry
              </Button>
            ) : (
              <div aria-hidden className="mt-6 space-y-3">
                <Skeleton h={72} />
                <Skeleton h={72} />
              </div>
            )}
          </OnboardingFrame>
        )
      )}
    </>
  )
}
