import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../lib/app-state'
import { connectionLabel, relativeTime } from '../lib/format'

/**
 * One thin line under a screen's header while the computer cannot be
 * reached: what is happening, how old the data on screen is, and a retry.
 * It says nothing at all while connected.
 */
export function ConnectionStrip({ detail }: { detail?: string }): ReactNode {
  const app = useApp()
  const [, tick] = useState(0)
  const connected = app.connection === 'connected'
  useEffect(() => {
    if (connected) return
    // Keeps "synced 2m ago" honest while the strip is up.
    const timer = setInterval(() => tick((count) => count + 1), 30_000)
    return () => clearInterval(timer)
  }, [connected])
  if (connected) return null
  const trying = app.connection === 'connecting' || app.connection === 'reconnecting'
  const synced =
    typeof app.lastSyncedAt === 'number' ? `updated ${relativeTime(app.lastSyncedAt)}` : null
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-4 text-xs text-fg-muted"
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${trying ? 'status-pulse bg-warning' : 'bg-fg-subtle'}`}
      />
      <span className="min-w-0 flex-1 truncate">
        {[
          trying ? `${connectionLabel(app.connection)}…` : connectionLabel(app.connection),
          synced,
          detail,
        ]
          .filter((part) => part !== null && part !== undefined)
          .join(' · ')}
      </span>
      {!trying && (
        <button
          type="button"
          className="-mr-2 min-h-9 shrink-0 px-2 font-medium text-fg"
          onClick={() => void app.reconnect()}
        >
          Retry
        </button>
      )}
    </div>
  )
}
