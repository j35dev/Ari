import { card, cx } from '../../lib/recipes'
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

/** The caption above a group, as on the settings pages. */
const caption = 'mb-2.5 text-[13px] font-medium text-fg-subtle'

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
    <section aria-label="ccusage" className="flex flex-col gap-[26px]">
      <div className={cx(card, 'flex flex-wrap items-end justify-between gap-x-8 gap-y-5 p-5')}>
        <div>
          <p className="text-xs text-fg-subtle">{range || 'No recorded usage'}</p>
          <p className="mt-1 text-[32px] font-semibold leading-10 tracking-[-0.02em] tabular-nums text-fg">
            {formatUsd(totalCost)}
          </p>
          <p className="mt-1 text-xs text-fg-subtle">
            {days.length === 1 ? '1 day' : `${days.length} days`} · API estimate
          </p>
        </div>
        <div className="min-w-[220px] flex-1">
          <p className="mb-2 text-xs capitalize text-fg-subtle">{granularity} cost</p>
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
                      className="min-w-1 flex-1 rounded-t-[2px] bg-fg-muted/60 transition-colors duration-[var(--ari-dur-fast)] hover:bg-fg motion-reduce:transition-none"
                      style={{ height: `${Math.max((cost / maxCost) * 100, 2)}%` }}
                    />
                  )
                })}
              </div>
              <div className="mt-1.5 flex justify-between text-xs tabular-nums text-fg-subtle">
                <span>{buckets[0]?.label}</span>
                <span>{buckets[buckets.length - 1]?.label}</span>
              </div>
            </>
          ) : (
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-xs text-fg-subtle">
              No usage in this window
            </div>
          )}
        </div>
      </div>

      <div>
        <h3 className={caption}>Totals</h3>
        <dl className={cx(card, 'grid grid-cols-2 gap-y-4 px-5 py-4 sm:grid-cols-5')}>
          <Stat label="Processed tokens" value={formatTokens(processed)} />
          <Stat label="Cached input" value={formatTokens(cacheRead)} />
          <Stat label="Uncached input" value={formatTokens(inputTokens)} />
          <Stat label="Output" value={formatTokens(outputTokens)} />
          <Stat label="Cache create" value={formatTokens(cacheCreate)} />
        </dl>
      </div>

      {shares.length > 0 ? (
        <div>
          <h3 className={caption}>Breakdown</h3>
          <div className={cx(card, 'overflow-hidden')}>
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="text-xs text-fg-subtle">
                  <th className="py-2.5 pl-4 pr-3 font-normal">Model</th>
                  <th className="px-3 py-2.5 text-right font-normal">Cost</th>
                  <th className="px-3 py-2.5 text-right font-normal">Share</th>
                  <th className="py-2.5 pl-3 pr-4 text-right font-normal">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {shares.map((row) => (
                  <tr key={row.modelName} className="border-t border-border">
                    <td className="max-w-[14rem] truncate py-3 pl-4 pr-3 font-mono text-[12.5px] text-fg">
                      {row.modelName}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-fg">
                      {formatUsd(row.cost)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-fg-muted">
                      {(row.share * 100).toFixed(1)}%
                    </td>
                    <td className="py-3 pl-3 pr-4 text-right tabular-nums text-fg-muted">
                      {formatTokens(row.tokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  )
}

/** A number with its caption beneath it; the caption stays first for assistive tech. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="mt-0.5 text-xs text-fg-subtle">{label}</dt>
      <dd className="text-[15px] font-medium tabular-nums text-fg">{value}</dd>
    </div>
  )
}
