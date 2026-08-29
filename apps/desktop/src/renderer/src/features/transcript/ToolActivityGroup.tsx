import { useState } from 'react'
import { ChevronRight, FilePen, FileText, Search, Terminal, type LucideIcon } from 'lucide-react'
import { ToolResultBody } from './ToolResultBody'
import { ThinkingBlock } from './ThinkingBlock'
import { activityHeadline, summarizeToolRun } from './groupBlocks'
import { describeToolCall, type ToolKind } from './toolLabels'
import type { ToolGroupRow, TranscriptBlock } from './types'

const KIND_ICON: Record<ToolKind, LucideIcon> = {
  run: Terminal,
  edit: FilePen,
  read: FileText,
  search: Search,
}

/** Pretty-prints a call's arguments, falling back to the raw payload. */
function prettyArgs(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson) as unknown, null, 2)
  } catch {
    return argsJson
  }
}

/**
 * One collapsed activity run: a single line reading "Ran 2 commands · Edited 1
 * file" while settled, or naming the in-flight call while working. Expanding
 * reveals one line per step — reasoning and tool calls in wire order — and each
 * of those opens to its own arguments and result. Nothing below the headline
 * renders until the user asks for it, so a fifty-step turn costs one row.
 */
export function ToolActivityGroup({ row }: { row: ToolGroupRow }) {
  const [open, setOpen] = useState(false)
  const summary = summarizeToolRun(row.calls, row.resultsByCallId)
  const headline = activityHeadline(row)
  const working = summary.pending > 0
  const steps = row.blocks.filter((block) => block.kind !== 'tool-result')

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-fg-subtle transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <span
          className={`min-w-0 flex-1 truncate text-xs ${working ? 'text-fg-muted' : 'text-fg-subtle'}`}
        >
          {headline}
        </span>
        {summary.errors > 0 ? (
          <span className="shrink-0 rounded-sm bg-danger-subtle px-1.5 py-0.5 text-2xs font-medium text-danger">
            {summary.errors} error{summary.errors === 1 ? '' : 's'}
          </span>
        ) : null}
        {working ? (
          <span
            aria-label="working"
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-warning"
          />
        ) : (
          <span className="size-1 shrink-0 rounded-full bg-success" aria-hidden="true" />
        )}
      </button>
      {open ? (
        <div className="ml-2 border-l border-border pl-2">
          {steps.map((step) =>
            step.kind === 'thinking' ? (
              <ThinkingBlock key={step.key} text={step.text ?? ''} />
            ) : (
              <ToolStep
                key={step.key}
                call={step}
                result={step.callId ? row.resultsByCallId.get(step.callId) : undefined}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * One tool call as a single line: verb, target, state. Opening it shows the
 * arguments and the result body (diff-aware via {@link ToolResultBody}).
 */
function ToolStep({
  call,
  result,
}: {
  call: TranscriptBlock
  result: TranscriptBlock | undefined
}) {
  const [open, setOpen] = useState(false)
  const { kind, verb, target } = describeToolCall(call)
  const Icon = KIND_ICON[kind]
  const failed = result?.isError === true

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${verb} ${target}`}
        className="flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <Icon
          size={11}
          className={`shrink-0 ${failed ? 'text-danger' : 'text-fg-subtle'}`}
          aria-hidden="true"
        />
        <span className="shrink-0 text-2xs text-fg-subtle">{verb}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-muted">{target}</span>
        {failed ? (
          <span className="shrink-0 text-2xs font-medium text-danger">failed</span>
        ) : result === undefined ? (
          <span
            aria-label="running"
            className="size-1 shrink-0 animate-pulse rounded-full bg-warning"
          />
        ) : null}
      </button>
      {open ? (
        <div
          className={`mb-1 ml-4 overflow-hidden rounded-md border bg-surface-1 ${
            failed ? 'border-danger' : 'border-border'
          }`}
        >
          {call.argsJson ? (
            <pre className="max-h-40 overflow-auto p-2 font-mono text-2xs text-fg-muted">
              {prettyArgs(call.argsJson)}
            </pre>
          ) : null}
          {result?.resultJson ? <ToolResultBody resultJson={result.resultJson} /> : null}
        </div>
      ) : null}
    </div>
  )
}
