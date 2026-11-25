import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FolderSearch } from 'lucide-react'
import { describeActivity, formatToolSummary } from './groupBlocks'
import { ActivityStep, StepBody } from './ActivityStep'
import { ImageGenerationActivity } from './ImageGenerationActivity'
import { ThinkingBlock } from './ThinkingBlock'
import { isImageGenerationCall } from './toolLabels'
import { burstSegments, exploreTally, type BurstSegment } from './burst-segments'
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
 * One stretch of work between two utterances. In conversation it is a few
 * quiet lines, the way Codex and Cursor show work: reads and searches fold
 * into one "Explored 2 files, 1 search" line (see `burstSegments`), every
 * command and edit keeps a line of its own with what came back (`exit 1`,
 * `+3 −2`), and a failed step carries its red dot where it happened. The step
 * the turn is on shimmers in the present tense and settles in place into the
 * past, so a line never moves or vanishes under the reader. A long burst shows
 * its newest lines and keeps the rest behind "N earlier steps".
 *
 * `active` marks the row a running turn is currently on. Liveness is scoped to
 * the turn rather than to whether some call happens to be unanswered: a burst
 * chains many calls, and between any two of them is a gap where nothing is in
 * flight, so per-call liveness had the row flickering on every gap.
 *
 * The terminal chat style keeps the older shape: one headline naming what the
 * burst touched, opening to every step in wire order on a single hairline. A
 * settled burst holding a single call opens straight to that call's body.
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
  const [showAll, setShowAll] = useState(false)
  const live = useHeldLive(active)
  const activity = useMemo(() => describeActivity(row, live), [row, live])
  const { verb, subject, more, label, summary } = activity
  const open = openOverride ?? terminal
  const steps = useMemo(() => row.blocks.filter((block) => block.kind !== 'tool-result'), [row])
  const segments = useMemo(() => burstSegments(steps), [steps])
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

  // In conversation the burst is its steps, one quiet line each: looking
  // around folds into one "Explored" line, commands and edits keep their own.
  // The running step shimmers in the present tense and settles in place into
  // the past, so nothing the reader was looking at moves or disappears. Only
  // the newest few lines show; the rest sit behind one line.
  if (!terminal) {
    const shown = showAll ? segments : segments.slice(-MAX_SEGMENTS)
    const earlier = segments.length - shown.length
    return (
      <div
        data-ari-part="tool-call"
        className="ari-burst my-1"
        data-activity={live ? 'working' : 'settled'}
        aria-label={named.join(' · ')}
      >
        <div className={live ? 'ari-burst-live' : undefined}>
          {earlier > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="flex h-6 items-center gap-1.5 rounded-md text-xs text-fg-subtle transition-colors hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              {earlier} earlier {earlier === 1 ? 'step' : 'steps'}
            </button>
          ) : null}
          {shown.map((segment, index) => {
            const newest = index === shown.length - 1
            return (
              <div key={segment.key} className={live ? 'ari-step-enter' : undefined}>
                {segment.kind === 'explore' ? (
                  <ExploreSegment
                    segment={segment}
                    results={row.resultsByCallId}
                    working={live && newest}
                    live={live}
                  />
                ) : (
                  <BurstStep
                    step={segment.block}
                    results={row.resultsByCallId}
                    terminal={false}
                    active={live}
                    newest={live && newest}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div
      data-ari-part="tool-call"
      className="ari-burst my-1"
      data-activity={live ? 'working' : 'settled'}
    >
      <button
        type="button"
        onClick={() => setOpenOverride((prev) => !(prev ?? terminal))}
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
        {summary.errors > 0 ? (
          <span className="ml-2 text-xs text-danger">{summary.errors} failed</span>
        ) : null}
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
                active={live}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  )
}

/** Lines a burst shows; older ones sit behind "N earlier steps". */
const MAX_SEGMENTS = 6
/** Steps an exploration lists under its line while it is under way. */
const EXPLORE_LIVE_STEPS = 4
/** Matches `--ari-dur-base`, the fold transition in transcript.css. */
const FOLD_MS = 320

/**
 * Plays the fold transition over what it wraps, then unmounts it. Mounted
 * open, folded on the next frame, so the grid-rows transition has a start.
 */
function FoldAway({ children, onDone }: { children: React.ReactNode; onDone: () => void }) {
  const [folded, setFolded] = useState(false)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    const frame = requestAnimationFrame(() => setFolded(true))
    const timer = setTimeout(() => doneRef.current(), FOLD_MS)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [])
  return (
    <div className="ari-fold" data-folded={folded ? '' : undefined} aria-hidden="true">
      <div>{children}</div>
    </div>
  )
}

/**
 * Reads and searches as one line. Under way it reads "Exploring" and lists
 * its newest steps beneath on the burst's hairline; once the turn moves on
 * the list folds away under "Explored 3 files, 1 search", which opens it
 * again.
 */
function ExploreSegment({
  segment,
  results,
  working,
  live,
}: {
  segment: Extract<BurstSegment, { kind: 'explore' }>
  results: Map<string, TranscriptBlock>
  /** The turn is on this exploration now. */
  working: boolean
  /** The burst is still live. */
  live: boolean
}) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const [wasWorking, setWasWorking] = useState(working)
  const [folding, setFolding] = useState(false)
  if (wasWorking !== working) {
    setWasWorking(working)
    if (wasWorking && openOverride === null) setFolding(true)
  }
  const open = openOverride ?? working

  // Thoughts with no reading around them stay thought lines.
  if (segment.calls.length === 0)
    return (
      <>
        {segment.blocks.map((block, index) => (
          <ThinkingBlock
            key={block.key}
            text={block.text ?? ''}
            compact
            live={working && index === segment.blocks.length - 1}
          />
        ))}
      </>
    )

  const tally = exploreTally(segment.calls)
  const failed = segment.calls.some(
    (call) => call.callId !== undefined && results.get(call.callId)?.isError === true,
  )
  const list = (blocks: TranscriptBlock[], active: boolean): React.ReactNode => (
    <div className={STEP_RAIL}>
      {blocks.map((block, index) => (
        <div key={block.key} className={active ? 'ari-step-enter' : undefined}>
          <BurstStep
            step={block}
            results={results}
            terminal={false}
            active={active}
            newest={active && index === blocks.length - 1}
          />
        </div>
      ))}
    </div>
  )

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpenOverride((previous) => !(previous ?? working))}
        aria-expanded={open}
        aria-label={`${working ? 'Exploring' : 'Explored'} ${tally}${failed ? ', error' : ''}`}
        className="group flex h-[30px] w-full min-w-0 items-center gap-2.5 rounded-md text-left text-[13.5px] text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        <FolderSearch size={14} className="shrink-0 text-fg-subtle" aria-hidden="true" />
        <span className={`shrink-0 ${working ? 'ari-shimmer' : ''}`}>
          {working ? 'Exploring' : 'Explored'}
        </span>
        <span className="min-w-0 truncate text-fg-subtle transition-colors group-hover:text-fg-muted">
          {tally}
        </span>
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`shrink-0 text-fg-subtle transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
        />
        {failed ? (
          <span className="ari-status ml-auto" data-status="error" aria-hidden="true" />
        ) : null}
      </button>
      {open
        ? list(
            working ? segment.blocks.slice(-EXPLORE_LIVE_STEPS) : segment.blocks,
            live && working,
          )
        : null}
      {!open && folding ? (
        <FoldAway onDone={() => setFolding(false)}>
          {list(segment.blocks.slice(-EXPLORE_LIVE_STEPS), false)}
        </FoldAway>
      ) : null}
    </div>
  )
}

function BurstStep({
  step,
  results,
  terminal,
  active,
  newest = false,
}: {
  step: TranscriptBlock
  results: Map<string, TranscriptBlock>
  terminal: boolean
  active: boolean
  /** The live burst's latest step: a thought there is still being had. */
  newest?: boolean
}) {
  if (step.kind === 'thinking')
    return (
      <ThinkingBlock text={step.text ?? ''} compact expanded={terminal} live={active && newest} />
    )
  return (
    <ActivityStep
      call={step}
      result={step.callId ? results.get(step.callId) : undefined}
      expanded={terminal}
      active={active}
    />
  )
}
