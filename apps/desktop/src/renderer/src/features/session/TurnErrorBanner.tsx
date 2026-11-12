import { useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import { cx, iconButton, outlineButton } from '../../lib/recipes'
import { friendlyErrorText } from '../moment'
import { classifyTurnError, UNCLASSIFIED_TITLE } from './turnError'

export interface TurnResume {
  /** When the provider's exhausted usage window reopens; null when unknown. */
  resetAt: number | null
  /** Last confirmed schedule. Null means absence only when scheduleKnown is true. */
  scheduledAt: number | null
  scheduleKnown: boolean
  pending: 'lookup' | 'schedule' | 'cancel' | null
  error: 'lookup' | 'schedule' | 'cancel' | null
  format: (at: number) => string
  onSchedule: () => void
  onCancel: () => void
  onCheck: () => void
}

const RESUME_ERRORS = {
  lookup: 'Could not check the resume schedule.',
  schedule: 'Could not confirm resume. Try again.',
  cancel: 'Could not cancel resume. Try again.',
}

/** A text action inside the row's own sentence: Cancel, Check schedule. */
const INLINE_ACTION =
  'rounded-sm text-fg underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-50'

/**
 * The turn-failed row above the composer, in the chat column: the red status
 * dot, the failure's family headline and friendly message, an actionable hint
 * when the classifier recognises the failure, a Retry action, and a Details
 * disclosure carrying the raw error text (stderr tails and exit codes live
 * there).
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
    <div role="alert" className="ari-chat-column mb-2 shrink-0">
      <div className="flex items-start gap-2.5 px-3">
        <span aria-hidden="true" className="ari-status mt-[4px]" data-status="error" />
        <div className="min-w-0 flex-1 py-0.5">
          <p className="break-words text-[13.5px] leading-relaxed text-fg">
            <span className="font-medium">{headline}</span> {friendly}
          </p>
          {hint !== null ? (
            <p className="mt-0.5 break-words text-[12.5px] leading-relaxed text-fg-muted">{hint}</p>
          ) : null}
          {resume ? (
            <div role="status" className="mt-1.5 text-[12.5px] text-fg-muted">
              {resume.pending === 'lookup' ? <p>Checking resume schedule…</p> : null}
              {resume.scheduledAt !== null ? (
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 break-words">
                    Ari will continue this session at {resume.format(resume.scheduledAt)}.
                  </span>
                  <button
                    type="button"
                    onClick={resume.onCancel}
                    disabled={resume.pending !== null}
                    className={INLINE_ACTION}
                  >
                    {resume.pending === 'cancel' ? 'Cancelling…' : 'Cancel'}
                  </button>
                </p>
              ) : resume.scheduleKnown && resume.resetAt !== null ? (
                <button
                  type="button"
                  onClick={resume.onSchedule}
                  disabled={resume.pending !== null}
                  title="Continue this session automatically once the usage limit resets"
                  className={cx(outlineButton, 'max-w-full')}
                >
                  {resume.pending === 'schedule'
                    ? 'Scheduling…'
                    : `Resume at ${resume.format(resume.resetAt)}`}
                </button>
              ) : null}
              {resume.error !== null ? (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 break-words text-fg">{RESUME_ERRORS[resume.error]}</span>
                  {resume.error === 'lookup' ? (
                    <button
                      type="button"
                      onClick={resume.onCheck}
                      disabled={resume.pending !== null}
                      className={INLINE_ACTION}
                    >
                      Check schedule
                    </button>
                  ) : null}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        {canRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={retryDisabled}
            aria-label="Retry last message"
            title="Resend the last message"
            className={cx(outlineButton, 'shrink-0')}
          >
            Retry
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setShowDetails((d) => !d)}
          aria-expanded={showDetails}
          aria-label="Toggle error details"
          className={iconButton}
        >
          <ChevronRight
            size={14}
            aria-hidden="true"
            className={`transition-transform duration-150 ${showDetails ? 'rotate-90' : ''}`}
          />
        </button>
        <button type="button" aria-label="Dismiss error" onClick={onDismiss} className={iconButton}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {showDetails ? (
        <pre className="mx-3 mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-0 p-2.5 font-mono text-xs text-fg-muted">
          {message}
        </pre>
      ) : null}
    </div>
  )
}
