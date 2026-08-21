import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { TranscriptBlock } from './types'

/** Short single-line preview of a tool's arguments. */
function summarizeArgs(parsed: unknown): string {
  if (parsed === null || parsed === undefined) return ''
  if (typeof parsed === 'string') return parsed.slice(0, 120)
  if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed)
  if (typeof parsed === 'object') {
    return Object.entries(parsed as Record<string, unknown>)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v)?.slice(0, 40) ?? ''}`)
      .join('  ')
  }
  return JSON.stringify(parsed) ?? ''
}

/**
 * Tool call card: name + state dot header, collapsible raw args/result.
 * Pairs visually with its sibling `tool-result` block via callId.
 */
export function ToolCallBlock({ block }: { block: TranscriptBlock }) {
  const [open, setOpen] = useState(false)
  let parsedArgs: unknown
  try {
    parsedArgs = block.argsJson ? (JSON.parse(block.argsJson) as unknown) : null
  } catch {
    parsedArgs = block.argsJson
  }
  const summary = summarizeArgs(parsedArgs)

  return (
    <div className="my-1 overflow-hidden rounded-md border border-border bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-fg-subtle transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <span className="font-mono text-xs text-fg">{block.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-subtle">{summary}</span>
        <span
          aria-label="running"
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warning"
        />
      </button>
      {open && block.argsJson ? (
        <pre className="max-h-40 overflow-auto border-t border-border bg-surface-0 p-2 font-mono text-2xs text-fg-muted">
          {block.argsJson}
        </pre>
      ) : null}
    </div>
  )
}

/** Completed tool result card; error state tints the border. */
export function ToolResultBlock({ block }: { block: TranscriptBlock }) {
  const [open, setOpen] = useState(false)
  let pretty: string = block.resultJson ?? ''
  try {
    pretty = JSON.stringify(JSON.parse(block.resultJson ?? ''), null, 2)
  } catch {
    // keep raw string
  }
  return (
    <div
      className={`my-1 overflow-hidden rounded-md border bg-surface-1 ${
        block.isError ? 'border-danger' : 'border-border'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-fg-subtle transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-2xs uppercase tracking-wide text-fg-subtle">result</span>
        {block.isError ? (
          <span className="rounded-sm bg-danger-subtle px-1 py-0.5 text-2xs font-medium text-danger">
            error
          </span>
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        )}
      </button>
      {open ? (
        <pre className="max-h-40 overflow-auto border-t border-border bg-surface-0 p-2 font-mono text-2xs text-fg-muted">
          {pretty}
        </pre>
      ) : null}
    </div>
  )
}
