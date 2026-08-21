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
}

function prettySummary(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json) as unknown, null, 2)
  } catch {
    return json
  }
}

/**
 * Inline transcript card for one pending approval. Focusable; while focused
 * `y` allows, `a` always-allows, `n` denies.
 */
export function ApprovalCard({ approvalId, toolName, summaryJson, onRespond }: ApprovalCardProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const decision: ApprovalDecision | null =
      event.key === 'y' ? 'allow' : event.key === 'a' ? 'always_allow' : event.key === 'n' ? 'deny' : null
    if (decision) {
      event.preventDefault()
      onRespond(decision)
    }
  }

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
      </div>
      <pre className="mt-2 max-h-32 overflow-auto font-mono text-2xs text-fg-muted">
        {prettySummary(summaryJson)}
      </pre>
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
