import type { KeyboardEvent } from 'react'
import { Button } from '@ari/ui/button'

/** Decision sent back to the engine for a pending approval. */
export type ApprovalDecision = 'allow' | 'always_allow' | 'deny'

export interface ApprovalCardProps {
  /** Engine-side approval request id; surfaced for correlation/debugging. */
  approvalId: string
  /** Name of the tool the agent wants to run. */
  toolName: string
  /** JSON string describing what the tool intends to do. */
  summaryJson: string
  /** Called with the user's decision (button click or shortcut key). */
  onRespond: (decision: ApprovalDecision) => void
  /** 1-based position among pending approvals (T3's "1/N" counter). */
  position?: number
  /** Total pending approvals; renders the counter with `position`. */
  total?: number
}

function prettySummary(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json) as unknown, null, 2)
  } catch {
    return json
  }
}

/**
 * Pulls the single most meaningful line out of a tool summary — the command
 * for shell-like tools, the path for file tools — so the card reads at a
 * glance and raw JSON stays as backup detail.
 */
export function approvalHeadline(summaryJson: string): { label: string; detail: string } | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(summaryJson) as Record<string, unknown>
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const command = parsed['command'] ?? parsed['cmd']
  if (typeof command === 'string' && command.trim().length > 0) {
    return { label: 'Command', detail: command }
  }
  const path = parsed['path'] ?? parsed['file_path'] ?? parsed['filePath']
  if (typeof path === 'string' && path.trim().length > 0) {
    return { label: 'File', detail: path }
  }
  return null
}

/**
 * Inline transcript card for one pending approval. Focusable; while focused
 * `y` allows, `a` always-allows, `n` denies. The headline line surfaces what
 * would actually run; the full JSON collapses under a "Raw" toggle.
 */
export function ApprovalCard({
  approvalId,
  toolName,
  summaryJson,
  onRespond,
  position,
  total,
}: ApprovalCardProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const decision: ApprovalDecision | null =
      event.key === 'y' ? 'allow' : event.key === 'a' ? 'always_allow' : event.key === 'n' ? 'deny' : null
    if (decision) {
      event.preventDefault()
      onRespond(decision)
    }
  }

  const headline = approvalHeadline(summaryJson)

  return (
    <div
      data-approval-id={approvalId}
      role="group"
      aria-label={`Approval requested: ${toolName}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="rounded-md border border-warning bg-surface-1 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
        <span className="font-mono text-xs text-fg">{toolName}</span>
        {position !== undefined && total !== undefined && total > 1 ? (
          <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-2xs leading-4 tabular-nums text-fg-subtle">
            {position}/{total} pending
          </span>
        ) : null}
      </div>
      {headline ? (
        <div className="mt-2 flex items-baseline gap-1.5 overflow-hidden">
          <span className="shrink-0 text-2xs uppercase tracking-[0.12em] text-fg-subtle">
            {headline.label}
          </span>
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={headline.detail}>
            {headline.detail}
          </code>
        </div>
      ) : null}
      <details className="mt-2 group">
        <summary className="cursor-pointer select-none text-2xs text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring">
          Raw request
        </summary>
        <pre className="mt-1.5 max-h-32 overflow-auto font-mono text-2xs text-fg-muted">
          {prettySummary(summaryJson)}
        </pre>
      </details>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => onRespond('allow')}>
          Allow
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onRespond('always_allow')}>
          Always allow
        </Button>
        <Button variant="danger" size="sm" onClick={() => onRespond('deny')}>
          Deny
        </Button>
      </div>
    </div>
  )
}
