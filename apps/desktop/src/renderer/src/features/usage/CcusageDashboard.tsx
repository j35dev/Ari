import {
  bucketDays,
  daysSince,
  formatRange,
  formatTokens,
  formatUsd,
  modelShares,
  type CcusageReport,
  type Granularity,
} from './parse-ccusage'

/**
 * Parsed ccusage report rendered for one time window: hero cost, a per-period
 * cost bar chart, token totals, and a model breakdown. Plain CSS — no chart
 * library. Weekly/monthly buckets are derived client-side from the
 * daily rows (same underlying data, no extra ccusage process).
 */
export function CcusageDashboard({
  report,
  granularity,
  since,
}: {
  report: CcusageReport
  granularity: Granularity
  /** Inclusive `YYYY-MM-DD` window start; null shows every recorded day. */
  since: string | null
}) {
  const days = daysSince(report.daily, since)
  const buckets = bucketDays(days, granularity)
  const shares = modelShares(days)

  const sum = (pick: (day: CcusageReport['daily'][number]) => number): number =>
    days.reduce((total, day) => total + pick(day), 0)
  const totalCost = sum((day) => day.totalCost)
  const inputTokens = sum((day) => day.inputTokens)
  const outputTokens = sum((day) => day.outputTokens)
  const cacheRead = sum((day) => day.cacheReadTokens)
  const cacheCreate = sum((day) => day.cacheCreationTokens)
  const processed = inputTokens + outputTokens + cacheRead + cacheCreate

  const maxCost = Math.max(...buckets.map((b) => b.days.reduce((t, d) => t + d.totalCost, 0)), 0.01)
  const range = formatRange(days)

  return (
    <section aria-label="ccusage" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-2xs text-fg-subtle">{range || 'No recorded usage'}</p>
          <p className="mt-1 font-mono text-4xl tabular-nums tracking-tight text-fg">
            {formatUsd(totalCost)}
          </p>
          <p className="mt-1 text-xs text-fg-subtle">
            {days.length === 1 ? '1 day' : `${days.length} days`} · API estimate
          </p>
        </div>
        <div className="min-w-[220px] flex-1">
          <p className="mb-1 text-2xs font-medium capitalize text-fg-subtle">{granularity} cost</p>
          {buckets.length > 0 ? (
            <>
              <div
                role="img"
                aria-label={`${granularity} cost chart`}
                className="flex h-24 items-end gap-1"
              >
                {buckets.map((bucket) => {
                  const cost = bucket.days.reduce((t, d) => t + d.totalCost, 0)
                  return (
                    <div
                      key={bucket.key}
                      title={`${bucket.label} · ${formatUsd(cost)}`}
                      className="min-w-1 flex-1 rounded-t-sm bg-accent/60 transition-colors duration-[var(--ari-dur-fast)] hover:bg-accent motion-reduce:transition-none"
                      style={{ height: `${Math.max((cost / maxCost) * 100, 2)}%` }}
                    />
                  )
                })}
              </div>
              <div className="mt-1 flex justify-between font-mono text-2xs text-fg-subtle">
                <span>{buckets[0]?.label}</span>
                <span>{buckets[buckets.length - 1]?.label}</span>
              </div>
            </>
          ) : (
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-2xs text-fg-subtle">
              No usage in this window
            </div>
          )}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">
          Totals
        </h3>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Processed tokens" value={formatTokens(processed)} />
          <Stat label="Cached input" value={formatTokens(cacheRead)} />
          <Stat label="Uncached input" value={formatTokens(inputTokens)} />
          <Stat label="Output" value={formatTokens(outputTokens)} />
          <Stat label="Cache create" value={formatTokens(cacheCreate)} />
        </dl>
      </div>

      {shares.length > 0 ? (
        <div>
          <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">
            Breakdown
          </h3>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-2xs uppercase tracking-[0.12em] text-fg-subtle">
                <th className="pb-2 font-medium">Model</th>
                <th className="pb-2 text-right font-medium">Cost</th>
                <th className="pb-2 text-right font-medium">Share</th>
                <th className="pb-2 text-right font-medium">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {shares.map((row) => (
                <tr key={row.modelName} className="border-t border-border">
                  <td className="max-w-[14rem] truncate py-2 font-mono text-fg">{row.modelName}</td>
                  <td className="py-2 text-right font-mono tabular-nums text-fg">{formatUsd(row.cost)}</td>
                  <td className="py-2 text-right font-mono tabular-nums text-fg-muted">
                    {(row.share * 100).toFixed(1)}%
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums text-fg-muted">
                    {formatTokens(row.tokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm tabular-nums text-fg">{value}</dd>
    </div>
  )
}
