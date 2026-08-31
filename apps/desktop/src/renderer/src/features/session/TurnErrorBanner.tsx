import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, X } from 'lucide-react'
import { friendlyErrorText } from '../moment'
import { classifyTurnError } from './turnError'

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
}: {
  /** Raw error text as it came off the turn settle event. */
  message: string
  canRetry: boolean
  retryDisabled: boolean
  onRetry: () => void
  onDismiss: () => void
}) {
  const [showDetails, setShowDetails] = useState(false)
  const { title, hint } = classifyTurnError(message)
  const friendly = friendlyErrorText(message)

  return (
    <div
      role="alert"
      className="mx-3 mb-1 rounded-md border border-danger-subtle bg-danger-subtle px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-xs leading-relaxed text-fg-muted">
            <span className="font-medium text-danger">Turn failed — {title}.</span> {friendly}
          </p>
          {hint !== null ? (
            <p className="mt-0.5 break-words text-2xs leading-relaxed text-fg-subtle">{hint}</p>
          ) : null}
        </div>
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
