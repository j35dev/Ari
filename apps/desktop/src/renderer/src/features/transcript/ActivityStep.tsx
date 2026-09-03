import { useMemo, useState } from 'react'
import {
  FilePen,
  FileText,
  ListChecks,
  Search,
  Terminal,
  type LucideIcon,
} from 'lucide-react'
import { ToolCallDetails } from './ToolCallDetails'
import { ToolResultBody } from './ToolResultBody'
import { editDiffStat } from './edit-diff'
import { resultHint } from './result-hint'
import { describeToolCall, effectiveToolName, humanizeToolName, type ToolKind } from './toolLabels'
import type { TranscriptBlock } from './types'

/** Glyph per bucket; the same set labels the ledger on a burst header. */
export const KIND_ICON: Record<ToolKind, LucideIcon> = {
  run: Terminal,
  edit: FilePen,
  read: FileText,
  search: Search,
  todo: ListChecks,
}

/**
 * Arguments and result of one call — the body a step row, or a burst holding a
 * single call, opens to.
 */
export function StepBody({
  call,
  result,
}: {
  call: TranscriptBlock
  result: TranscriptBlock | undefined
}) {
  if (call.argsJson === undefined && result?.resultJson === undefined) return null
  return (
    <div className="ari-burst-steps mb-1 ml-4 overflow-hidden rounded-md border border-border bg-surface-1">
      {call.argsJson ? <ToolCallDetails call={call} /> : null}
      {result?.resultJson ? <ToolResultBody resultJson={result.resultJson} /> : null}
    </div>
  )
}

/**
 * One tool call as a row of a burst's timeline: glyph, verb, target, and what
 * came back — an edit's diffstat, or the result parsed down to one honest
 * readout (`exit 1`, `84 lines`, `12 matches`). The columns are fixed so
 * targets line up down the list instead of stair-stepping behind verbs of
 * different widths, which is what makes a twenty-step run scannable. A call
 * with no showable argument reads as its humanized tool name across both text
 * columns rather than pairing a verb with a raw id.
 */
export function ActivityStep({
  call,
  result,
}: {
  call: TranscriptBlock
  result: TranscriptBlock | undefined
}) {
  const [open, setOpen] = useState(false)
  const step = useMemo(() => {
    const { kind, verb, target } = describeToolCall(call, result === undefined)
    const nameOnly = target.length === 0
    return {
      kind,
      verb,
      target,
      nameOnly,
      label: nameOnly
        ? humanizeToolName(effectiveToolName(call.name, call.argsJson))
        : `${verb} ${target}`,
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
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={failed ? `${label}, error` : label}
        className="grid w-full grid-cols-[13px_3.5rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-1 py-[3px] text-left transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        <Icon size={11} className="text-fg-subtle" aria-hidden="true" />
        {nameOnly ? (
          <span className="col-span-2 truncate font-mono text-2xs text-fg-muted">{label}</span>
        ) : (
          <>
            <span className="truncate text-2xs text-fg-subtle">{verb}</span>
            <span className="truncate font-mono text-2xs text-fg-muted">{target}</span>
          </>
        )}
        <span className="flex items-center gap-1.5 font-mono text-2xs">
          {stat !== null && (stat.added > 0 || stat.removed > 0) ? (
            <span className="text-fg-subtle tabular-nums">
              +{stat.added} −{stat.removed}
            </span>
          ) : null}
          {hint !== null ? (
            <span className={failed ? 'truncate text-warning/80' : 'truncate text-fg-subtle'}>
              {hint}
            </span>
          ) : null}
          {result === undefined ? (
            <span className="ari-pulse size-1 rounded-full bg-accent" aria-hidden="true" />
          ) : null}
        </span>
      </button>
      {open ? <StepBody call={call} result={result} /> : null}
    </div>
  )
}
