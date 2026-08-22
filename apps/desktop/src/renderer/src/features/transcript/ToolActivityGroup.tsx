import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { ToolCallBlock, ToolResultBlock } from './ToolBlocks'
import { formatToolSummary, summarizeToolRun } from './groupBlocks'
import type { ToolGroupRow } from './types'

/**
 * One collapsed tool run (Zeron-style activity row): "Ran 2 commands ·
 * Edited 1 file" with an error badge when anything failed and a pulsing dot
 * while a call is still in flight. Clicking expands the individual cards.
 */
export function ToolActivityGroup({ row }: { row: ToolGroupRow }) {
  const [open, setOpen] = useState(false)
  const summary = summarizeToolRun(row.calls, row.resultsByCallId)
  const label = formatToolSummary(summary)
  const working = summary.pending > 0

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-fg-subtle transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">
          {label || `${row.calls.length} tool call${row.calls.length === 1 ? '' : 's'}`}
        </span>
        {summary.errors > 0 ? (
          <span className="shrink-0 rounded-sm bg-danger-subtle px-1.5 py-0.5 text-2xs font-medium text-danger">
            {summary.errors} error{summary.errors === 1 ? '' : 's'}
          </span>
        ) : null}
        {working ? (
          <span aria-label="working" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warning" />
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        )}
      </button>
      {open ? (
        <div className="ml-3 border-l border-border pl-2">
          {row.calls.map((call) => {
            const result = call.callId ? row.resultsByCallId.get(call.callId) : undefined
            return (
              <div key={call.key}>
                <ToolCallBlock block={call} />
                {result ? <ToolResultBlock block={result} /> : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
