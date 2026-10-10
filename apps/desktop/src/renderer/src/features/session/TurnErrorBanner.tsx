import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, X } from 'lucide-react'
import { friendlyErrorText } from '../moment'
import { classifyTurnError, UNCLASSIFIED_TITLE } from './turnError'

export interface TurnResume {
  /** When the provider's exhausted usage window reopens; null when unknown. */
  resetAt: number | null
  /** When Ari is already set to continue the session; null when it is not. */
  scheduledAt: number | null
  format: (at: number) => string
  onSchedule: () => void
  onCancel: () => void
}

/**
 * The turn-failed banner docked above the composer: a danger strip with the
 * failure's family headline, the friendly message, an actionable hint when the
 * classifier recognises the failure, a Retry action, and a Details disclosure
 * carrying the raw error text (stderr tails and exit codes live there).
 */
export function TurnErrorBanner({
  message,
  canRetry,
  retryDisabled,
  onRetry,
  onDismiss,
  resume,
}: {
  /** Raw error text as it came off the turn settle event. */
  message: string
  canRetry: boolean
  retryDisabled: boolean
  onRetry: () => void
  onDismiss: () => void
  /** Offered when a usage limit stopped the turn and the provider says when it resets. */
  resume?: TurnResume
}) {
  const [showDetails, setShowDetails] = useState(false)
  const { title, hint } = classifyTurnError(message)
  const friendly = friendlyErrorText(message)
  // An unclassified failure has no family to name, so the headline stays bare
  // rather than repeating itself before the raw message.
  const headline = title === UNCLASSIFIED_TITLE ? 'Turn failed —' : `Turn failed — ${title}.`

  return (
    <div
      role="alert"
      className="mx-3 mb-1 rounded-md border border-danger-subtle bg-danger-subtle px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-xs leading-relaxed text-fg-muted">
            <span className="font-medium text-danger">{headline}</span> {friendly}
          </p>
          {hint !== null ? (
            <p className="mt-0.5 break-words text-2xs leading-relaxed text-fg-subtle">{hint}</p>
          ) : null}
          {resume?.scheduledAt != null ? (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-fg-muted">
              <span>Ari will continue this session at {resume.format(resume.scheduledAt)}.</span>
              <button
                type="button"
                onClick={resume.onCancel}
                className="rounded-sm underline decoration-dotted underline-offset-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                Cancel
              </button>
            </p>
          ) : null}
        </div>
        {resume && resume.scheduledAt == null && resume.resetAt !== null ? (
          <button
            type="button"
            onClick={resume.onSchedule}
            title="Continue this session automatically once the usage limit resets"
            className="shrink-0 rounded-sm border border-border px-2 py-0.5 text-2xs font-medium text-fg transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            Resume at {resume.format(resume.resetAt)}
          </button>
        ) : null}
        {canRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={retryDisabled}
            aria-label="Retry last message"
            title="Resend the last message"
            className="shrink-0 rounded-sm border border-danger px-2 py-0.5 text-2xs font-medium text-danger transition-colors hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-50"
          >
            Retry
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setShowDetails((d) => !d)}
          aria-expanded={showDetails}
          aria-label="Toggle error details"
          className="shrink-0 rounded-sm p-0.5 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          {showDetails ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <button
          type="button"
          aria-label="Dismiss error"
          onClick={onDismiss}
          className="shrink-0 rounded-sm p-0.5 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <X size={12} />
        </button>
      </div>
      {showDetails ? (
        <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-surface-0 p-2 font-mono text-2xs text-fg-muted">
          {message}
        </pre>
      ) : null}
    </div>
  )
}
