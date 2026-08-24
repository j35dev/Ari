import { useEffect, useState } from 'react'
import type { UsageSummary } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { formatRelativeTime } from '../../shell/Sidebar'

/** Compact token readout: 9,999 stays exact, anything larger rounds to K. */
function formatTokens(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function formatCost(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-1 p-3">
      <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">{label}</p>
      <p className="mt-1 truncate font-mono text-lg tabular-nums text-fg">{value}</p>
    </div>
  )
}

/**
 * Usage dashboard (M18.5): global token/cost totals plus one row per session
 * that recorded usage, served by `usage.summary`. Bars are plain CSS over
 * design tokens — no chart library — sized relative to the busiest session.
 */
export function UsageDashboard({ onOpenSession }: { onOpenSession?: (sessionId: string) => void } = {}) {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void rpc
      .invoke('usage.summary')
      .then((s) => {
        if (!cancelled) setSummary(s)
      })
      .catch(() => {
        if (!cancelled) setError('Usage summary failed to load.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error !== null) {
    return (
      <section aria-label="Usage" className="p-4">
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      </section>
    )
  }

  // Quiet first paint: the summary is one cheap RPC away.
  if (summary === null) return null

  if (summary.rows.length === 0) {
    return (
      <section
        aria-label="Usage"
        className="flex h-full flex-col items-center justify-center px-6 text-center"
      >
        <p className="text-xs leading-relaxed text-fg-subtle">
          No usage recorded yet.
          <br />
          Run a session — token counts land here.
        </p>
      </section>
    )
  }

  const showCost = summary.totals.costUsd !== null
  const maxRowTotal = Math.max(
    1,
    ...summary.rows.map((r) => r.inputTokens + r.outputTokens),
  )

  return (
    <section aria-label="Usage" className="ari-scroll flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div className={`grid gap-3 ${showCost ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <StatCard label="Input tokens" value={formatTokens(summary.totals.inputTokens)} />
        <StatCard label="Output tokens" value={formatTokens(summary.totals.outputTokens)} />
        {showCost ? <StatCard label="Cost" value={formatCost(summary.totals.costUsd ?? 0)} /> : null}
      </div>

      <ul className="flex flex-col gap-2" aria-label="Sessions by usage">
        {summary.rows.map((row) => {
          const total = row.inputTokens + row.outputTokens
          return (
            <li key={row.sessionId} className="rounded-md border border-border bg-surface-1 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                {onOpenSession ? (
                  <button
                    type="button"
                    onClick={() => onOpenSession(row.sessionId)}
                    className="min-w-0 flex-1 truncate text-left text-sm font-medium text-fg hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                  >
                    {row.title}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{row.title}</span>
                )}
                <span
                  title={`Driver: ${row.driverKind}`}
                  className="shrink-0 rounded-full border border-border bg-surface-1 px-1.5 font-mono text-2xs text-fg-muted"
                >
                  {row.driverKind}
                </span>
                <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">
                  {formatRelativeTime(row.updatedAt)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-3 font-mono text-2xs tabular-nums text-fg-muted">
                <span title={`Input tokens: ${row.inputTokens}`}>↑ {formatTokens(row.inputTokens)}</span>
                <span title={`Output tokens: ${row.outputTokens}`}>↓ {formatTokens(row.outputTokens)}</span>
                {showCost && row.costUsd !== null ? (
                  <span title="Estimated cost">{formatCost(row.costUsd)}</span>
                ) : null}
                <span className="ml-auto shrink-0 text-fg-subtle" title={`${total} tokens total`}>
                  {total === 0 ? '' : `${Math.round((total / maxRowTotal) * 100)}%`}
                </span>
              </div>
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${Math.round((total / maxRowTotal) * 100)}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>

      <p className="text-2xs text-fg-subtle">
        Across {summary.rows.length} session{summary.rows.length === 1 ? '' : 's'} with recorded usage.
      </p>
    </section>
  )
}
