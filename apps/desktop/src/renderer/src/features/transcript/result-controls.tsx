export const resultButton =
  'inline-flex items-center justify-center rounded-md px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40'

export function ResultError({ message }: { message: string }) {
  const long = message.length > 180 || message.includes('\n')
  return (
    <div className="text-xs text-danger">
      <p role="alert" className="break-words">
        {long ? `${(message.split('\n')[0] ?? '').slice(0, 180)}…` : message}
      </p>
      {long ? (
        <details className="mt-1 text-2xs text-fg-muted">
          <summary className="cursor-pointer">Error details</summary>
          <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">{message}</p>
        </details>
      ) : null}
    </div>
  )
}
