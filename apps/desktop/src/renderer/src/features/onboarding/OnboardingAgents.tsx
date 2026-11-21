import { useEffect, useState, type Ref } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Plus } from 'lucide-react'
import type { DriverKind } from '@ari/contracts/common'
import { Button } from '@ari/ui/button'
import { ProviderLogo } from '../composer/provider-logo'
import {
  OTHER_AGENTS,
  RECOMMENDED,
  agentAccount,
  agentName,
  usable,
  usableAgents,
  type CliAgent,
} from './agent-catalog'
import { AgentFlow, Details, commandLine, hasFlow } from './AgentFlow'
import { ONBOARDING_LEAD_CLASS, ONBOARDING_TITLE_CLASS } from './OnboardingFrame'
import type { AriCoreConnection } from './OnboardingAriCore'
import { StepFooter } from './StepFooter'
import { DrawnCheck, listItem, staggerList, useCalm } from './onboarding-motion'
import type { AgentSetup } from './use-agent-setup'

export type AgentsView = 'list' | 'get'

/** The one trailing state of an agent row: Ready, Sign in or Install. */
function Trailing({
  kind,
  setup,
  compact = false,
}: {
  kind: CliAgent
  setup: AgentSetup
  compact?: boolean
}) {
  const stage = setup.stageOf(kind)
  const name = agentName(kind)
  if (stage.kind === 'ready') return <ReadyMark fresh={setup.justReady(kind)} />
  if (stage.kind === 'checking')
    return <span className="shrink-0 text-[12.5px] text-fg-subtle">Checking…</span>
  if (stage.kind === 'installing' || stage.kind === 'signing-in')
    return (
      <span className="shrink-0 text-[12.5px] text-fg-subtle">
        {stage.kind === 'installing' ? 'Installing…' : 'Signing in…'}
      </span>
    )
  if (stage.kind === 'needs-sign-in')
    return (
      <Button
        size="sm"
        aria-label={`Sign in to ${name}`}
        disabled={setup.busy}
        onClick={() => void setup.signIn(kind)}
      >
        Sign in
      </Button>
    )
  if (stage.kind === 'failed') return null
  const blocked = setup.plans[kind]?.prerequisite != null
  return (
    <Button
      size="sm"
      variant={compact ? 'ghost' : 'secondary'}
      aria-label={`Install ${name}`}
      disabled={setup.busy || blocked || setup.detections === null}
      onClick={() => void setup.install(kind)}
    >
      Install
    </Button>
  )
}

/** Ready: a green dot, or a check that draws itself when it just became ready. */
function ReadyMark({ fresh }: { fresh: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-fg-muted">
      {fresh ? (
        <DrawnCheck size={13} />
      ) : (
        <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
      )}
      Ready
    </span>
  )
}

function Tile({ kind, small = false }: { kind: string; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`ari-onboarding-tile ${small ? 'size-6! rounded-md! [&>svg]:size-3.5!' : ''}`}
    >
      <ProviderLogo kind={kind} />
    </span>
  )
}

/** An agent that is installed: a radio row with its account and one state. */
function AgentRow({
  kind,
  setup,
  selected,
  onSelect,
  subtitle,
}: {
  kind: DriverKind
  setup: AgentSetup
  selected: boolean
  onSelect: () => void
  subtitle?: string
}) {
  const cli = kind === 'ari-core' ? null : kind
  return (
    <motion.li variants={listItem} layout="position">
      <div className={`ari-onboarding-row ${selected ? 'is-selected' : ''}`}>
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          aria-label={agentName(kind)}
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <span className="ari-onboarding-radio" aria-hidden="true" />
          <Tile kind={kind} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-fg">{agentName(kind)}</span>
            <span className="mt-px block truncate text-[12.5px] text-fg-subtle">
              {subtitle ?? agentAccount(kind)}
            </span>
          </span>
        </button>
        {cli ? <Trailing kind={cli} setup={setup} /> : <ReadyMark fresh />}
      </div>
      {cli && hasFlow(cli, setup) && (
        <div className="pb-2 pl-[76px] pr-3 pt-1">
          <AgentFlow kind={cli} setup={setup} />
        </div>
      )}
    </motion.li>
  )
}

/** A not-yet-installed agent in a compact list. */
function InstallRow({ kind, setup }: { kind: CliAgent; setup: AgentSetup }) {
  return (
    <motion.li variants={listItem} layout="position">
      <div className="flex items-center gap-3 rounded-lg px-3 py-1.5">
        <Tile kind={kind} small />
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
          {agentName(kind)}
          <span className="ml-2 text-[12.5px] text-fg-subtle">{agentAccount(kind)}</span>
        </span>
        <Trailing kind={kind} setup={setup} compact />
      </div>
      {hasFlow(kind, setup) && (
        <div className="pb-2 pl-12 pr-3 pt-0.5">
          <AgentFlow kind={kind} setup={setup} />
        </div>
      )}
    </motion.li>
  )
}

/** One of the two agents Ari recommends when none is installed. */
function RecommendedCard({
  kind,
  needs,
  setup,
}: {
  kind: CliAgent
  needs: string
  setup: AgentSetup
}) {
  const stage = setup.stageOf(kind)
  const command = commandLine(setup.plans[kind])
  return (
    <motion.li
      variants={listItem}
      layout="position"
      className={`flex min-w-0 flex-col gap-3 rounded-xl border p-3.5 transition-colors ${
        stage.kind === 'ready' ? 'border-border-strong bg-fg/4' : 'border-border'
      }`}
    >
      <div className="flex items-center gap-3">
        <Tile kind={kind} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{agentName(kind)}</span>
          <span className="mt-px block text-[12.5px] leading-[17px] text-fg-subtle">
            {stage.kind === 'ready' ? agentAccount(kind) : needs}
          </span>
        </span>
        <Trailing kind={kind} setup={setup} />
      </div>
      {hasFlow(kind, setup) ? (
        <AgentFlow kind={kind} setup={setup} />
      ) : (
        stage.kind === 'missing' && command !== null && <Details label="Details">{command}</Details>
      )}
    </motion.li>
  )
}

/**
 * The agent step. With an agent installed it is a radio list; with none it is
 * a "get an agent" view whose installs run in place, through sign-in, until
 * the agent reads Ready. Ari Core is the third way in, for keys and local models.
 */
export function OnboardingAgents({
  view,
  setup,
  selected,
  core,
  onSelect,
  onUseCore,
  onBack,
  onContinue,
  headingRef,
  primaryRef,
}: {
  view: AgentsView
  setup: AgentSetup
  selected: DriverKind | null
  core: AriCoreConnection | null
  onSelect: (kind: DriverKind) => void
  onUseCore: () => void
  onBack: () => void
  onContinue: () => void
  headingRef: Ref<HTMLHeadingElement>
  primaryRef: Ref<HTMLButtonElement>
}) {
  const calm = useCalm()
  const [adding, setAdding] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const found = usableAgents(setup.detections)
  const missing = (
    view === 'get' ? OTHER_AGENTS : [...RECOMMENDED.map((r) => r.kind), ...OTHER_AGENTS]
  ).filter((kind) => !usable(setup.detections?.find((d) => d.kind === kind)))
  const visible = showAll ? found : found.slice(0, 4)

  // The exact commands are ready to read before anything is clicked.
  const { plan } = setup
  useEffect(() => {
    if (view !== 'get') return
    void (async () => {
      for (const { kind } of RECOMMENDED) await plan(kind)
    })()
  }, [view, plan])

  const ready =
    selected !== null && (selected === 'ari-core' ? core !== null : setup.isReady(selected))
  const footer = (
    <StepFooter
      onBack={onBack}
      primaryRef={primaryRef}
      primary={{
        label: selected === null ? 'Skip for now' : 'Continue',
        disabled: setup.busy,
        onClick: onContinue,
      }}
      extra={
        view === 'list' ? (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={adding}
            onClick={() => setAdding((prev) => !prev)}
          >
            <Plus size={14} strokeWidth={1.7} aria-hidden="true" /> Add another agent
          </Button>
        ) : undefined
      }
    />
  )
  const coreLink = (
    <button
      type="button"
      onClick={onUseCore}
      className="mt-4 rounded-sm text-[13px] text-fg-muted underline-offset-4 transition-colors hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      No subscription? Use an API key or a local model
    </button>
  )
  const status = (
    <>
      {setup.scanError && (
        <p role="alert" className="mt-3 text-[13px] text-fg">
          {setup.scanError}{' '}
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => void setup.scan(true)}
          >
            Check again
          </button>
        </p>
      )}
      {setup.actionError && (
        <p role="alert" className="mt-3 flex items-start gap-2 text-[13px] leading-5 text-fg">
          <span className="ari-status mt-[5px]" data-status="error" aria-hidden="true" />
          <span className="min-w-0 flex-1">{setup.actionError}</span>
        </p>
      )}
    </>
  )

  // An install, failure or sign-in needs the stage's width: the cards stack while one runs.
  const focused = RECOMMENDED.some(({ kind }) => hasFlow(kind, setup))
  if (view === 'get')
    return (
      <div>
        <h2 ref={headingRef} tabIndex={-1} className={ONBOARDING_TITLE_CLASS}>
          Get a coding agent
        </h2>
        <p className={ONBOARDING_LEAD_CLASS}>
          Nothing is installed yet. Pick one and Ari installs it, then signs you in.
        </p>
        <motion.ul
          aria-label="Recommended agents"
          className={`mt-5 grid items-start gap-2.5 ${focused ? 'grid-cols-1' : 'grid-cols-2'}`}
          variants={staggerList(0.07)}
          initial={calm ? false : 'hidden'}
          animate="shown"
        >
          {RECOMMENDED.map(({ kind, needs }) => (
            <RecommendedCard key={kind} kind={kind} needs={needs} setup={setup} />
          ))}
        </motion.ul>
        <p className="mb-1 mt-5 px-3 text-xs text-fg-subtle">Other agents</p>
        <motion.ul
          aria-label="Other agents"
          className="flex flex-col"
          variants={staggerList(0.04, 0.16)}
          initial={calm ? false : 'hidden'}
          animate="shown"
        >
          {missing.map((kind) => (
            <InstallRow key={kind} kind={kind} setup={setup} />
          ))}
        </motion.ul>
        {status}
        {core === null && coreLink}
        {footer}
      </div>
    )

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className={ONBOARDING_TITLE_CLASS}>
        Choose your agent
      </h2>
      <p className={ONBOARDING_LEAD_CLASS}>
        Ari runs the coding agents on this computer. Your sign-ins stay with them.
      </p>
      <motion.ul
        role="radiogroup"
        aria-label="Your agent"
        className="mt-5 flex flex-col gap-0.5"
        variants={staggerList()}
        initial={calm ? false : 'hidden'}
        animate="shown"
      >
        {visible.map((detection) => (
          <AgentRow
            key={detection.kind}
            kind={detection.kind as DriverKind}
            setup={setup}
            selected={selected === detection.kind}
            onSelect={() => onSelect(detection.kind as DriverKind)}
          />
        ))}
        {core !== null && (
          <AgentRow
            kind="ari-core"
            setup={setup}
            selected={selected === 'ari-core'}
            onSelect={() => onSelect('ari-core')}
            subtitle={`${core.name} · ${core.models} models`}
          />
        )}
      </motion.ul>
      {found.length > visible.length && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="ml-3 mt-1 rounded-sm text-[12.5px] text-fg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          {found.length - visible.length} more found
        </button>
      )}
      <AnimatePresence initial={false}>
        {adding && (
          <motion.div
            key="adding"
            initial={calm ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={calm ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <p className="mb-1 mt-4 px-3 text-xs text-fg-subtle">Install another agent</p>
            <motion.ul
              aria-label="Agents to install"
              className="flex flex-col"
              variants={staggerList(0.04)}
              initial={calm ? false : 'hidden'}
              animate="shown"
            >
              {missing.map((kind) => (
                <InstallRow key={kind} kind={kind} setup={setup} />
              ))}
            </motion.ul>
            {core === null && <div className="px-3">{coreLink}</div>}
          </motion.div>
        )}
      </AnimatePresence>
      {status}
      {!ready && selected !== null && selected !== 'ari-core' && (
        <p className="mt-3 px-3 text-[12.5px] text-fg-subtle">
          {agentName(selected)} needs a sign-in before its first message. You can do it now or
          later.
        </p>
      )}
      {footer}
    </div>
  )
}
