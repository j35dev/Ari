import type { ReactNode } from 'react'

const ring = [0, 1, 2, 5, 8, 7, 6, 3]

/** Desktop's forging matrix, kept quiet and visible beside the mobile composer. */
export function WorkingIndicator({ sending = false }: { sending?: boolean }): ReactNode {
  return (
    <div
      role="status"
      aria-label={sending ? 'Sending' : 'Working'}
      aria-live="polite"
      aria-atomic="true"
      className="flex items-center gap-2 px-2 pb-2 text-xs text-fg-muted"
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
    </div>
  )
}
