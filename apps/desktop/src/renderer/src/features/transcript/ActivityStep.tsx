import { useMemo, useState } from 'react'
import { FilePen, FileText, ListChecks, Search, Terminal, type LucideIcon } from 'lucide-react'
import { ToolCallDetails } from './ToolCallDetails'
import { ToolResultBody } from './ToolResultBody'
import { editDiffStat } from './edit-diff'
import { resultHint } from './result-hint'
import { describeToolCall, namelessStepLabel, type ToolKind } from './toolLabels'
import type { TranscriptBlock } from './types'

/** Glyph per bucket, leading each step of a burst's timeline. */
export const KIND_ICON: Record<ToolKind, LucideIcon> = {
  run: Terminal,
  edit: FilePen,
  read: FileText,
  search: Search,
  todo: ListChecks,
}

/**
 * Arguments and result of one call — the well a step row, or a burst holding a
 * single call, opens to.
 */
export function StepBody({
  call,
  result,
  expanded = false,
}: {
  call: TranscriptBlock
  result: TranscriptBlock | undefined
  expanded?: boolean
}) {
  if (call.argsJson === undefined && result?.resultJson === undefined) return null
  return (
    <div className="ari-tool-body ari-burst-steps mb-2 mt-1 overflow-hidden rounded-lg border border-border bg-surface-0 text-[length:var(--ari-well-text,12.5px)] leading-relaxed text-fg-muted">
      {call.argsJson ? <ToolCallDetails call={call} /> : null}
      {result?.resultJson ? (
        <ToolResultBody resultJson={result.resultJson} expanded={expanded} />
      ) : null}
    </div>
  )
}

/**
 * One tool call as one line of a burst's timeline: glyph, verb, target, and at
 * the far right what came back — an edit's diffstat, or the result parsed down
 * to one honest readout (`exit 1`, `84 lines`, `12 matches`). A call with no
 * showable argument reads as its humanized tool name rather than pairing a
 * verb with a raw id. A failed call carries the red status dot, a pending one
 * the working ring.
 */
export function ActivityStep({
  call,
  result,
  expanded = false,
}: {
  call: TranscriptBlock
  result: TranscriptBlock | undefined
  expanded?: boolean
}) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const open = openOverride ?? expanded
  const step = useMemo(() => {
    const { kind, verb, target } = describeToolCall(call, result === undefined)
    const nameOnly = target.length === 0
    return {
      kind,
      verb,
      target,
      nameOnly,
      label: nameOnly ? namelessStepLabel(call, result === undefined) : `${verb} ${target}`,
      stat: kind === 'edit' && !nameOnly ? editDiffStat(call.argsJson) : null,
      hint: resultHint(kind, result?.resultJson, result?.isError === true),
    }
  }, [call, result])
  const { verb, target, nameOnly, label, stat, hint } = step
  const Icon = KIND_ICON[step.kind]
  const failed = result?.isError === true

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpenOverride((previous) => !(previous ?? expanded))}
        aria-expanded={open}
        aria-label={failed ? `${label}, error` : label}
        className="group flex h-[30px] w-full min-w-0 items-center gap-2.5 rounded-md text-left text-[13.5px] text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        <Icon size={14} className="shrink-0 text-fg-subtle" aria-hidden="true" />
        {nameOnly ? (
          <span className="min-w-0 truncate">{label}</span>
        ) : (
          <>
            <span className="shrink-0">{verb}</span>
            <span className="min-w-0 truncate font-mono text-[12.5px] text-fg-subtle transition-colors group-hover:text-fg-muted">
              {target}
            </span>
          </>
        )}
        <span className="ml-auto flex min-w-0 max-w-[45%] shrink-0 items-center gap-2 pl-2 font-mono text-xs text-fg-subtle">
          {stat !== null && (stat.added > 0 || stat.removed > 0) ? (
            <span className="flex shrink-0 gap-1.5 tabular-nums">
              <span className="text-success">+{stat.added}</span>
              <span className="text-danger">−{stat.removed}</span>
            </span>
          ) : null}
          {hint !== null ? <span className="min-w-0 truncate">{hint}</span> : null}
          {failed ? <span className="ari-status" data-status="error" aria-hidden="true" /> : null}
          {result === undefined ? (
            <span className="ari-status" data-status="working" aria-hidden="true" />
          ) : null}
        </span>
      </button>
      {open ? <StepBody call={call} result={result} expanded={expanded} /> : null}
    </div>
  )
}
