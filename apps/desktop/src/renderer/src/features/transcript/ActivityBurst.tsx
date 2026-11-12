import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { describeActivity, formatToolSummary } from './groupBlocks'
import { ActivityStep, StepBody } from './ActivityStep'
import { ImageGenerationActivity } from './ImageGenerationActivity'
import { ThinkingBlock } from './ThinkingBlock'
import { isImageGenerationCall } from './toolLabels'
import type { ToolGroupRow, TranscriptBlock } from './types'

/** How long a row that just went quiet stays open before it folds away. */
const CLOSE_HOLD_MS = 300

/** The single hairline an opened burst's steps hang on. */
const STEP_RAIL = 'ml-1.5 mt-0.5 border-l border-border-strong pl-4'

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
 * One stretch of work between two utterances, as one quiet line: what the
 * assistant is doing now, or what it did. The line names the *subjects* it
 * touched (`Edited groupBlocks.ts, types.ts +1`); the full tally stays in the
 * accessible name and the hover title rather than on screen, so fifteen bursts
 * in a session read as fifteen grey lines, not fifteen rows of counts. Colour
 * is kept out of history: a settled burst is subtle text and a chevron, and
 * the working ring marks the one the turn is on. Tool-result errors stay
 * folded inside their step; the burst headline never counts them.
 *
 * `active` marks the row a running turn is currently on. Liveness is scoped to
 * the turn rather than to whether some call happens to be unanswered: a burst
 * chains many calls, and between any two of them is a gap where nothing is in
 * flight, so per-call liveness had the row opening and shutting on every gap.
 * Turn-scoped, the row opens once and folds once, and calls append into it.
 *
 * Expanding reveals the timeline: one line per step in wire order on a single
 * hairline, each step opening to its own arguments and result. A settled burst
 * holding a single call skips the intermediate list and opens straight to that
 * call's body.
 */
export function ActivityBurst({
  row,
  active,
  terminal = false,
}: {
  row: ToolGroupRow
  active: boolean
  terminal?: boolean
}) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const live = useHeldLive(active)
  const activity = useMemo(() => describeActivity(row, live), [row, live])
  const { verb, subject, more, label, summary } = activity
  const open = openOverride ?? (terminal || live)
  const steps = row.blocks.filter((block) => block.kind !== 'tool-result')
  // The lone-call shortcut trades the step list for the call's own body. Held
  // back while the turn runs: a burst grows from one call to many as the model
  // chains them, and swapping the body's shape mid-turn reads as the thing you
  // were reading collapsing. Live, the body is append-only.
  const lone =
    !terminal && !live && steps.length === 1 && steps[0]?.kind === 'tool-call'
      ? steps[0]
      : undefined
  const tally = formatToolSummary(summary)

  const imageCall = row.calls.length === 1 ? row.calls[0] : undefined
  if (live && imageCall !== undefined && isImageGenerationCall(imageCall)) {
    return <ImageGenerationActivity call={imageCall} />
  }

  const named = [live ? `Working: ${label}` : label]
  if (tally.length > 0 && tally !== label) named.push(tally)

  return (
    <div className="ari-burst my-1" data-activity={live ? 'working' : 'settled'}>
      <button
        type="button"
        onClick={() => setOpenOverride((prev) => !(prev ?? (terminal || live)))}
        aria-expanded={open}
        aria-label={named.join(' · ')}
        title={tally.length > 0 ? tally : undefined}
        className={`group flex h-7 w-fit max-w-full items-center gap-1.5 rounded-md text-left text-sm transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
          live ? 'text-fg-muted' : 'text-fg-subtle'
        }`}
      >
        {live ? (
          <span className="ari-status mr-1" data-status="working" aria-hidden="true" />
        ) : null}
        <span className="min-w-0 truncate">
          {verb}
          {subject.length > 0 ? (
            <span className="ml-1.5 font-mono text-[12.5px]">{subject}</span>
          ) : null}
          {more > 0 ? <span className="ml-1.5 text-xs">+{more}</span> : null}
        </span>
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open ? (
        lone !== undefined ? (
          <div className={STEP_RAIL}>
            <StepBody
              call={lone}
              result={lone.callId ? row.resultsByCallId.get(lone.callId) : undefined}
            />
          </div>
        ) : (
          <div className={`ari-burst-steps ${STEP_RAIL}`}>
            {steps.map((step) => (
              <BurstStep
                key={step.key}
                step={step}
                results={row.resultsByCallId}
                terminal={terminal}
              />
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
  terminal,
}: {
  step: TranscriptBlock
  results: Map<string, TranscriptBlock>
  terminal: boolean
}) {
  if (step.kind === 'thinking')
    return <ThinkingBlock text={step.text ?? ''} compact expanded={terminal} />
  return (
    <ActivityStep
      call={step}
      result={step.callId ? results.get(step.callId) : undefined}
      expanded={terminal}
    />
  )
}
