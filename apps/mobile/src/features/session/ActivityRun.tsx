import { useState, type ReactNode } from 'react'
import {
  ChevronRight,
  CircleAlert,
  FileText,
  Lightbulb,
  ListChecks,
  PencilLine,
  Search,
  Terminal,
  type LucideIcon,
} from 'lucide-react'
import { activitySteps, activitySummary, type ActivityStep } from '../../lib/activity'
import type { ConversationPart } from '../../lib/conversation-parts'

const icons: Record<ActivityStep['kind'], LucideIcon> = {
  read: FileText,
  edit: PencilLine,
  run: Terminal,
  search: Search,
  todo: ListChecks,
  thought: Lightbulb,
}
/** A finished run longer than this folds into a count. */
const FOLD_AFTER = 3

/** A run of reasoning and tool calls, one line each; a long finished run folds into a count. */
export function ActivityRun({
  parts,
  live,
}: {
  parts: readonly ConversationPart[]
  live: boolean
}): ReactNode {
  const steps = activitySteps(parts, live)
  const foldable = !live && steps.length > FOLD_AFTER
  const [unfolded, setUnfolded] = useState(false)
  const shown = !foldable || unfolded ? steps : steps.filter((step) => step.failed)
  return (
    <div className="my-2">
      {foldable && (
        <button
          type="button"
          aria-expanded={unfolded}
          aria-label={activitySummary(steps)}
          className="flex min-h-10 items-center gap-2 text-[13px] text-fg-muted"
          onClick={() => setUnfolded((open) => !open)}
        >
          <ChevronRight
            size={14}
            className={`shrink-0 transition-transform ${unfolded ? 'rotate-90' : ''}`}
          />
          {activitySummary(steps)}
        </button>
      )}
      <ul>
        {shown.map((step) => (
          <Step key={step.key} step={step} live={live} />
        ))}
      </ul>
    </div>
  )
}

function Step({ step, live }: { step: ActivityStep; live: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  const Icon = step.failed ? CircleAlert : icons[step.kind]
  const running = live && step.pending
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${step.label} ${step.target}`.trim() + (step.failed ? ', failed' : '')}
        className={`flex min-h-10 w-full items-center gap-2 text-left text-[13px] ${step.failed ? 'text-danger' : 'text-fg-muted'}`}
        onClick={() => setOpen((shown) => !shown)}
      >
        <Icon size={14} className="shrink-0" />
        <span className={`shrink-0 ${running ? 'shimmer' : ''}`}>{step.label}</span>
        <span
          className={`min-w-0 truncate ${step.kind === 'thought' ? '' : 'font-mono text-xs'} ${step.failed ? '' : 'text-fg-subtle'}`}
        >
          {step.target}
        </span>
      </button>
      {open && (
        <div className="mb-2 ml-[22px] space-y-2">
          {step.kind !== 'thought' && step.input !== null && (
            <pre className="step-detail max-h-40">{step.input}</pre>
          )}
          {step.output !== null ? (
            <pre className={`step-detail max-h-72 ${step.kind === 'thought' ? 'font-ui' : ''}`}>
              {step.output}
            </pre>
          ) : (
            <p className="text-xs text-fg-subtle">{running ? 'Still running…' : 'No result.'}</p>
          )}
        </div>
      )}
    </li>
  )
}
