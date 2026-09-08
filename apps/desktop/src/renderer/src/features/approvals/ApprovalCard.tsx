import type { KeyboardEvent } from 'react'
import { Button } from '@ari/ui/button'

/** Decision sent back to the engine for a pending approval. */
export type ApprovalDecision = 'allow' | 'always_allow' | 'deny'

/** Underscores and hyphens become spaces so `Ari_delegation` reads as a name. */
export function formatApprovalToolName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

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
  const rawInput = parsed['rawInput']
  if (rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    parsed = rawInput as Record<string, unknown>
  }
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

function supportsAlwaysAllow(summaryJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(summaryJson)
    if (parsed === null || typeof parsed !== 'object') return true
    const options = (parsed as Record<string, unknown>)['options']
    if (!Array.isArray(options)) return true
    return options.some(
      (option: unknown) =>
        option !== null &&
        typeof option === 'object' &&
        (option as Record<string, unknown>)['kind'] === 'allow_always',
    )
  } catch {
    return true
  }
}

function ShortcutHint({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="font-mono text-[10px] font-normal opacity-60">
      {children}
    </span>
  )
}

/**
 * Inline permission sheet for one pending approval. Focusable; while focused
 * `y` allows, `a` always-allows, `n` denies. The headline surfaces what would
 * actually run; the full JSON collapses under a "Raw" toggle.
 */
export function ApprovalCard({
  approvalId,
  toolName,
  summaryJson,
  onRespond,
  position,
  total,
}: ApprovalCardProps) {
  const canAlwaysAllow = supportsAlwaysAllow(summaryJson)
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const decision: ApprovalDecision | null =
      event.key === 'y'
        ? 'allow'
        : event.key === 'a'
          ? 'always_allow'
          : event.key === 'n'
            ? 'deny'
            : null
    if (decision) {
      if (decision === 'always_allow' && !canAlwaysAllow) return
      event.preventDefault()
      onRespond(decision)
    }
  }

  const headline = approvalHeadline(summaryJson)
  const displayName = formatApprovalToolName(toolName)

  return (
    <div
      data-approval-id={approvalId}
      role="group"
      aria-label={`Approval requested: ${toolName}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="rounded-lg border border-border bg-surface-1 p-3 shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-fg">Permission needed</p>
            {position !== undefined && total !== undefined && total > 1 ? (
              <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-2xs leading-4 tabular-nums text-fg-subtle">
                {position}/{total} pending
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-2xs text-fg-muted">{displayName}</p>

          {headline ? (
            <div className="mt-2.5 rounded-md bg-surface-2/70 px-2.5 py-2">
              <p className="text-2xs uppercase tracking-[0.12em] text-fg-subtle">
                {headline.label}
              </p>
              <code
                className="mt-0.5 block truncate font-mono text-xs leading-5 text-fg"
                title={headline.detail}
              >
                {headline.detail}
              </code>
            </div>
          ) : null}

          <details className="mt-2">
            <summary className="cursor-pointer select-none text-2xs text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring">
              Raw request
            </summary>
            <pre className="mt-1.5 max-h-32 overflow-auto rounded-md bg-surface-2/50 p-2 font-mono text-2xs text-fg-muted">
              {prettySummary(summaryJson)}
            </pre>
          </details>

          <div className="mt-3 flex items-center justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              title="Deny (N)"
              className="text-danger hover:bg-danger-subtle"
              onClick={() => onRespond('deny')}
            >
              Deny
              <ShortcutHint>N</ShortcutHint>
            </Button>
            {canAlwaysAllow ? (
              <Button
                variant="secondary"
                size="sm"
                title="Always allow (A)"
                onClick={() => onRespond('always_allow')}
              >
                Always allow
                <ShortcutHint>A</ShortcutHint>
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              title="Allow (Y)"
              onClick={() => onRespond('allow')}
            >
              Allow
              <ShortcutHint>Y</ShortcutHint>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
