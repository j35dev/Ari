import { useEffect, useState, type ReactNode } from 'react'

const ring = [0, 1, 2, 5, 8, 7, 6, 3]

/** Desktop's forging matrix, kept quiet and visible beside the mobile composer. */
export function WorkingIndicator({
  sending = false,
  since,
}: {
  sending?: boolean
  /** When the turn began, to show how long the agent has been at it. */
  since?: number
}): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === undefined) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [since])
  const elapsed = since === undefined ? null : Math.max(0, Math.floor((now - since) / 1000))
  return (
    <div
      role="status"
      aria-label={sending ? 'Sending' : 'Working'}
      aria-live="polite"
      aria-atomic="true"
      className="mx-auto mb-2 flex w-fit items-center gap-2 rounded-full bg-surface-1 px-3 py-1.5 text-xs text-fg-muted"
    >
      <span aria-hidden="true" className="grid grid-cols-3 gap-0.5">
        {Array.from({ length: 9 }, (_, cell) => (
          <span
            key={cell}
            className={`size-1 rounded-[1px] bg-accent ${cell === 4 ? 'opacity-25' : 'mobile-working-cell'}`}
            style={cell === 4 ? undefined : { animationDelay: `${ring.indexOf(cell) * -0.15}s` }}
          />
        ))}
      </span>
      {sending ? 'Sending to your computer…' : 'Working…'}
      {!sending && elapsed !== null && (
        <span aria-hidden className="tabular-nums text-fg-subtle">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
        </span>
      )}
    </div>
  )
}
