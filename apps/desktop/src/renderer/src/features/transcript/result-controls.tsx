import { quietButton } from '../../lib/recipes'

/** A quiet 28px text action inside a delegated result. */
export const resultButton = quietButton

/**
 * A failure inside a delegated result: the red status dot and what went wrong
 * in plain ink, with the full message folded below when it is long.
 */
export function ResultError({ message }: { message: string }) {
  const long = message.length > 180 || message.includes('\n')
  return (
    <div className="text-[13px] text-fg">
      <p role="alert" className="flex items-start gap-2 break-words">
        <span className="ari-status mt-[3px]" data-status="error" aria-hidden="true" />
        <span className="min-w-0">
          {long ? `${(message.split('\n')[0] ?? '').slice(0, 180)}…` : message}
        </span>
      </p>
      {long ? (
        <details className="mt-1 pl-[22px] text-xs text-fg-muted">
          <summary className="cursor-pointer rounded-sm transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring">
            Error details
          </summary>
          <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">{message}</p>
        </details>
      ) : null}
    </div>
  )
}
