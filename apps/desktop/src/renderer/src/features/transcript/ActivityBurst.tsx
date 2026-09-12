import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { describeActivity, formatToolSummary, type ActivityLedgerEntry } from './groupBlocks'
import { ActivityStep, KIND_ICON, StepBody } from './ActivityStep'
import { ImageGenerationActivity } from './ImageGenerationActivity'
import { ThinkingBlock } from './ThinkingBlock'
import { isImageGenerationCall } from './toolLabels'
import type { ToolGroupRow, TranscriptBlock } from './types'

/** How long a row that just went quiet stays open before it folds away. */
const CLOSE_HOLD_MS = 300

/**
 * Holds `live` for a beat after the turn stops running. A settled turn that
 * immediately dequeues a queued message starts the next one within
 * milliseconds (`turn.settled` → `turn.started`), so without the hold the row
 * would fold away and spring back once per turn boundary. Opening is never
 * delayed: the row is up the moment there is work to show.
 */
function useHeldLive(live: boolean): boolean {
  const [held, setHeld] = useState(live)

  useEffect(() => {
    if (live) {
      setHeld(true)
      return
    }
    const timer = setTimeout(() => setHeld(false), CLOSE_HOLD_MS)
    return () => clearTimeout(timer)
  }, [live])

  return held
}

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
 * counted nouns. The rail carries the state — travelling light for as long as
 * the turn is on this row, a near-invisible hairline once settled — which keeps
 * color out of history and reserves it for what is happening now. Tool-result
 * errors stay folded inside their step; the burst headline never counts them.
 *
 * `active` marks the row a running turn is currently on. Liveness is scoped to
 * the turn rather than to whether some call happens to be unanswered: a burst
 * chains many calls, and between any two of them is a gap where nothing is in
 * flight, so per-call liveness had the row opening and shutting on every gap.
 * Turn-scoped, the row opens once and folds once, and calls append into it.
 *
 * Expanding reveals the timeline: one aligned row per step in wire order,
 * reasoning as dim italic previews, each step opening to its own arguments and
 * result. A settled burst holding a single call skips the intermediate list and
 * opens straight to that call's body.
 */
export function ActivityBurst({ row, active }: { row: ToolGroupRow; active: boolean }) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const live = useHeldLive(active)
  const activity = useMemo(() => describeActivity(row, live), [row, live])
  const { verb, subject, more, label, summary, ledger, stat } = activity
  const open = openOverride ?? live
  const steps = row.blocks.filter((block) => block.kind !== 'tool-result')
  // The lone-call shortcut trades the step list for the call's own body. Held
  // back while the turn runs: a burst grows from one call to many as the model
  // chains them, and swapping the body's shape mid-turn reads as the thing you
  // were reading collapsing. Live, the body is append-only.
  const lone = !live && steps.length === 1 && steps[0]?.kind === 'tool-call' ? steps[0] : undefined
  const tally = formatToolSummary(summary)

  const imageCall = row.calls.length === 1 ? row.calls[0] : undefined
  if (live && imageCall !== undefined && isImageGenerationCall(imageCall)) {
    return <ImageGenerationActivity call={imageCall} />
  }

  const named = [live ? `Working: ${label}` : label]
  if (tally.length > 0 && tally !== label) named.push(tally)

  return (
    <div className="ari-burst my-1 pl-3" data-activity={live ? 'working' : 'settled'}>
      <button
        type="button"
        onClick={() => setOpenOverride((prev) => !(prev ?? live))}
        aria-expanded={open}
        aria-label={named.join(' · ')}
        className="group flex w-full items-center gap-2 rounded-md px-1 py-[3px] text-left transition-colors hover:bg-surface-1/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        {live ? (
          <span className="flex shrink-0 items-center gap-1 font-mono text-2xs text-accent">
            <span className="ari-pulse size-1 rounded-full bg-accent" aria-hidden="true" />
            live
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">
          <span className={`text-xs ${live ? 'text-fg' : 'text-fg-subtle'}`}>{verb}</span>
          {subject.length > 0 ? (
            <span className={`ml-1.5 font-mono text-2xs ${live ? 'text-fg' : 'text-fg-muted'}`}>
              {subject}
            </span>
          ) : null}
          {more > 0 ? (
            <span className="ml-1 font-mono text-2xs text-fg-subtle">+{more}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-3">
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
          className={`shrink-0 text-fg-subtle opacity-40 transition-transform duration-150 group-hover:opacity-100 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
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
  if (step.kind === 'thinking') return <ThinkingBlock text={step.text ?? ''} compact />
  return <ActivityStep call={step} result={step.callId ? results.get(step.callId) : undefined} />
}
