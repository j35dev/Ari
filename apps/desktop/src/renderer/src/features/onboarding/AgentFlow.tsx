import { useState, type Ref } from 'react'
import { motion } from 'motion/react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@ari/ui/button'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { TerminalPane } from '../terminal/TerminalPane'
import type { InstallState } from '../providers/use-provider-installs'
import { agentName, type CliAgent } from './agent-catalog'
import { fill, useCalm } from './onboarding-motion'
import type { AgentSetup, InstallPlan } from './use-agent-setup'

const log = createLogger('onboarding:install')

/** How far along each queue phase reads; the bar glides between them. */
const PHASE_PROGRESS: Record<NonNullable<InstallState['phase']>, number> = {
  queued: 0.06,
  waiting: 0.1,
  preparing: 0.2,
  downloading: 0.45,
  installing: 0.7,
  verifying: 0.9,
}

const PHASE_LABEL: Record<NonNullable<InstallState['phase']>, string> = {
  queued: 'Waiting to start',
  waiting: 'Waiting for running work',
  preparing: 'Preparing',
  downloading: 'Downloading',
  installing: 'Installing',
  verifying: 'Verifying',
}

/** A quiet disclosure for raw text: the exact command, or the installer's output. */
export function Details({ label = 'Details', children }: { label?: string; children: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1 rounded-sm text-[12.5px] text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ChevronRight
          size={12}
          strokeWidth={1.8}
          aria-hidden="true"
          className={`transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {label}
      </button>
      {open && (
        <pre className="ari-scroll mt-1.5 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-0 px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] text-fg-muted">
          {children}
        </pre>
      )}
    </div>
  )
}

export function commandLine(plan: InstallPlan | null | undefined): string | null {
  return plan ? plan.installCommand.join(' ') : null
}

/** The live phase from the update queue as a gliding bar, with Cancel. */
export function InstallProgress({
  kind,
  install,
  onCancel,
}: {
  kind: CliAgent
  install: InstallState
  onCancel: () => void
}) {
  const calm = useCalm()
  const phase = install.phase ?? 'queued'
  const value = PHASE_PROGRESS[phase]
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div
          role="progressbar"
          aria-label={`Installing ${agentName(kind)}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(value * 100)}
          aria-valuetext={install.message ?? PHASE_LABEL[phase]}
          className="relative h-1 overflow-hidden rounded-full bg-fg/10"
        >
          <motion.span
            className="ari-onboarding-progress absolute inset-y-0 left-0 rounded-full bg-fg"
            initial={calm ? false : { width: '0%' }}
            animate={{ width: `${value * 100}%` }}
            transition={calm ? { duration: 0 } : fill}
          />
        </div>
        <p
          role="status"
          className="mt-1.5 truncate text-[12.5px] text-fg-subtle"
          title={install.message}
        >
          {PHASE_LABEL[phase]}
          {install.message && install.message !== PHASE_LABEL[phase] ? ` · ${install.message}` : ''}
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

/** Something this computer lacks for the install, and the official place to get it. */
export function Prerequisite({
  kind,
  plan,
  onRecheck,
}: {
  kind: CliAgent
  plan: InstallPlan
  onRecheck: () => void
}) {
  const need = plan.prerequisite
  if (!need) return null
  return (
    <div className="space-y-2">
      <p role="alert" className="text-[13px] leading-5 text-fg-muted">
        {agentName(kind)} installs with{' '}
        <code className="font-mono text-[12.5px]">{need.program}</code>, which comes with{' '}
        {need.label}. {need.label} isn’t on this computer yet.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() =>
            void rpc
              .invoke('shell.openUrl', { url: need.url })
              .catch((error: unknown) => log.warn('could not open installer page', error))
          }
        >
          Get {need.label}
        </Button>
        <Button size="sm" variant="ghost" onClick={onRecheck}>
          I’ve installed it
        </Button>
      </div>
      <Details label="Command">{plan.installCommand.join(' ')}</Details>
    </div>
  )
}

/** A failed install: the reason in plain words, Retry, and the raw output on demand. */
export function InstallFailure({
  reason,
  details,
  onRetry,
}: {
  reason: string
  details: string
  onRetry: () => void
}) {
  return (
    <div className="space-y-2">
      <p role="alert" className="flex items-start gap-2 text-[13px] leading-5 text-fg">
        <span className="ari-status mt-[5px]" data-status="error" aria-hidden="true" />
        <span className="min-w-0 flex-1">{reason}</span>
      </p>
      <div className="flex flex-wrap items-start gap-3">
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
        {details.trim().length > 0 && <Details>{details.trim()}</Details>}
      </div>
    </div>
  )
}

/** The agent's own sign-in, running in place. */
export function SignInTerminal({
  setup,
  doneRef,
}: {
  setup: AgentSetup
  doneRef?: Ref<HTMLButtonElement>
}) {
  const terminal = setup.terminal
  if (!terminal) return null
  return (
    <section
      aria-label={`${agentName(terminal.kind)} sign-in`}
      className="overflow-hidden rounded-lg border border-border bg-surface-0"
    >
      <div className="flex items-center gap-2 border-b border-border py-1.5 pl-3 pr-1.5">
        <p className="min-w-0 flex-1 truncate text-[12.5px] text-fg-subtle">
          Follow the steps below. Your browser may open to finish.
        </p>
        <Button size="sm" variant="ghost" onClick={() => setup.closeTerminal()}>
          Cancel
        </Button>
        <Button ref={doneRef} size="sm" onClick={() => void setup.finishSignIn(terminal.kind)}>
          I’ve signed in
        </Button>
      </div>
      <div className="h-44">
        <TerminalPane terminalId={terminal.id} cwd={terminal.cwd} attachOnly active />
      </div>
    </section>
  )
}

/** Everything that unfolds under an agent once the user acts on it. */
export function AgentFlow({ kind, setup }: { kind: CliAgent; setup: AgentSetup }) {
  const stage = setup.stageOf(kind)
  const plan = setup.plans[kind]
  if (stage.kind === 'installing')
    return (
      <InstallProgress
        kind={kind}
        install={stage.install}
        onCancel={() => void setup.cancel(kind)}
      />
    )
  if (stage.kind === 'failed')
    return (
      <InstallFailure
        reason={stage.reason}
        details={stage.details}
        onRetry={() => void setup.install(kind)}
      />
    )
  if (stage.kind === 'signing-in') return <SignInTerminal setup={setup} />
  if (stage.kind === 'missing' && plan?.prerequisite)
    return <Prerequisite kind={kind} plan={plan} onRecheck={() => void setup.plan(kind)} />
  if (stage.kind === 'needs-sign-in' && stage.note)
    return <p className="text-[12.5px] leading-5 text-fg-subtle">{stage.note}</p>
  return null
}

/** True when {@link AgentFlow} has something to show for this agent. */
export function hasFlow(kind: CliAgent, setup: AgentSetup): boolean {
  const stage = setup.stageOf(kind)
  return (
    stage.kind === 'installing' ||
    stage.kind === 'failed' ||
    stage.kind === 'signing-in' ||
    (stage.kind === 'missing' && setup.plans[kind]?.prerequisite != null) ||
    (stage.kind === 'needs-sign-in' && stage.note !== null)
  )
}
