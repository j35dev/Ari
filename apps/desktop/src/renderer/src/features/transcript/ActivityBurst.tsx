import { useMemo, useState } from 'react'
import { ChevronRight, TriangleAlert } from 'lucide-react'
import { describeActivity, formatToolSummary, type ActivityLedgerEntry } from './groupBlocks'
import { ActivityStep, KIND_ICON, StepBody } from './ActivityStep'
import { ThinkingBlock } from './ThinkingBlock'
import type { ToolGroupRow, TranscriptBlock } from './types'

/**
 * Buckets the headline left unsaid, as glyph+count pairs — `⌨2 ⌕1` reads in one
 * glance where "Ran 2 commands · Searched 1 time" has to be read word by word.
 * The counts stay right-aligned so they form a column down a long session, and
 * they are mirrored into the header's accessible name rather than announced
 * twice.
 */
function ActivityLedger({ entries }: { entries: ActivityLedgerEntry[] }) {
  if (entries.length === 0) return null
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center gap-2 text-fg-subtle transition-colors group-hover:text-fg-muted"
    >
      {entries.map(({ kind, count }) => {
        const Icon = KIND_ICON[kind]
        return (
          <span key={kind} className="flex items-center gap-1 font-mono text-2xs tabular-nums">
            <Icon size={11} />
            {count}
          </span>
        )
      })}
    </span>
  )
}

/**
 * One stretch of work between two utterances, rendered as a hairline rail with
 * a single headline: what the assistant is doing now, or what it did. The
 * headline names the *subjects* it touched (`Edited groupBlocks.ts, types.ts
 * +1`) with the tally demoted to the glyph ledger on the right, so fifteen
 * bursts in a session no longer read as fifteen interchangeable sentences of
 * counted nouns. The rail carries the state — travelling light while a call is
 * unanswered, warning-tinted when a step failed, a near-invisible hairline once
 * settled — which keeps color out of history and reserves it for what is
 * happening now.
 *
 * Expanding reveals the timeline: one aligned row per step in wire order,
 * reasoning as dim italic previews, each step opening to its own arguments and
 * result. A burst holding a single call skips the intermediate list and opens
 * straight to that call's body.
 */
export function ActivityBurst({ row }: { row: ToolGroupRow }) {
  const [open, setOpen] = useState(false)
  const activity = useMemo(() => describeActivity(row), [row])
  const { verb, subject, more, label, working, summary, ledger, stat } = activity
  const steps = row.blocks.filter((block) => block.kind !== 'tool-result')
  const lone = steps.length === 1 && steps[0]?.kind === 'tool-call' ? steps[0] : undefined
  const failed = summary.errors > 0
  const tally = formatToolSummary(summary)

  const named = [working ? `Working: ${label}` : label]
  if (tally.length > 0 && tally !== label) named.push(tally)
  if (failed) named.push(`${summary.errors} failed`)

  return (
    <div
      className="ari-burst my-1 pl-3"
      data-activity={working ? 'working' : failed ? 'failed' : 'settled'}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={named.join(' · ')}
        className="group flex w-full items-center gap-2 rounded-md px-1 py-[3px] text-left transition-colors hover:bg-surface-1/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        <span className="min-w-0 flex-1 truncate">
          <span className={`text-xs ${working ? 'text-fg' : 'text-fg-subtle'}`}>{verb}</span>
          {subject.length > 0 ? (
            <span
              className={`ml-1.5 font-mono text-2xs ${working ? 'text-fg' : 'text-fg-muted'}`}
            >
              {subject}
            </span>
          ) : null}
          {more > 0 ? (
            <span className="ml-1 font-mono text-2xs text-fg-subtle">+{more}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {failed ? (
            <span
              aria-hidden="true"
              className="flex items-center gap-1 font-mono text-2xs tabular-nums text-warning"
            >
              <TriangleAlert size={11} />
              {summary.errors}
            </span>
          ) : null}
          {stat !== null && (stat.added > 0 || stat.removed > 0) ? (
            <span aria-hidden="true" className="font-mono text-2xs tabular-nums text-fg-muted">
              +{stat.added} −{stat.removed}
            </span>
          ) : null}
          <ActivityLedger entries={ledger} />
        </span>
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={`shrink-0 text-fg-subtle opacity-40 transition-all duration-150 group-hover:opacity-100 ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open ? (
        lone !== undefined ? (
          <StepBody
            call={lone}
            result={lone.callId ? row.resultsByCallId.get(lone.callId) : undefined}
          />
        ) : (
          <div className="ari-burst-steps pb-1 pl-0.5">
            {steps.map((step) => (
              <BurstStep key={step.key} step={step} results={row.resultsByCallId} />
            ))}
          </div>
        )
      ) : null}
    </div>
  )
}

function BurstStep({
  step,
  results,
}: {
  step: TranscriptBlock
  results: Map<string, TranscriptBlock>
}) {
  if (step.kind === 'thinking') return <ThinkingBlock text={step.text ?? ''} />
  return <ActivityStep call={step} result={step.callId ? results.get(step.callId) : undefined} />
}
