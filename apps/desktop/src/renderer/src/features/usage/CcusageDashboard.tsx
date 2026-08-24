import { formatRange, formatTokens, formatUsd, modelShares, type CcusageReport } from './parse-ccusage'

function sparkPath(values: number[], width: number, height: number): string {
  if (values.length === 0) return ''
  const max = Math.max(...values, 0.01)
  return values
    .map((value, i) => {
      const x = values.length === 1 ? width / 2 : (i / (values.length - 1)) * width
      const y = height - (value / max) * (height - 4) - 2
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

function fillPath(values: number[], width: number, height: number): string {
  const line = sparkPath(values, width, height)
  if (line.length === 0) return ''
  return `${line} L${width} ${height} L0 ${height} Z`
}

/**
 * Parsed ccusage report rendered as a dashboard: hero cost, daily sparkline,
 * totals, and a model breakdown. CSS + SVG only — no chart library.
 */
export function CcusageDashboard({ report }: { report: CcusageReport }) {
  const days = report.daily
  const costs = days.map((d) => d.totalCost)
  const shares = modelShares(report)
  const sessionHint = days.length === 1 ? '1 day' : `${days.length} days`
  const range = formatRange(days)
  const processed =
    report.totals.inputTokens +
    report.totals.outputTokens +
    report.totals.cacheCreationTokens +
    report.totals.cacheReadTokens

  return (
    <section aria-label="ccusage" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="text-2xs text-fg-subtle">{range || 'All recorded days'}</p>
          <p className="mt-1 font-mono text-4xl tabular-nums tracking-tight text-fg">
            {formatUsd(report.totals.totalCost)}
          </p>
          <p className="mt-1 text-xs text-fg-subtle">{sessionHint} · API estimate</p>
        </div>
        <div className="min-w-[220px] flex-1">
          <p className="mb-1 text-2xs font-medium text-fg-subtle">Daily cost</p>
          <svg viewBox="0 0 320 88" className="h-24 w-full text-accent" role="img" aria-label="Daily cost chart">
            <path d={fillPath(costs, 320, 88)} fill="currentColor" className="opacity-20" />
            <path d={sparkPath(costs, 320, 88)} fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          {days.length > 0 ? (
            <div className="flex justify-between font-mono text-2xs text-fg-subtle">
              <span>{days[0]?.date}</span>
              <span>{days[days.length - 1]?.date}</span>
            </div>
          ) : null}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">Totals</h3>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Processed tokens" value={formatTokens(processed)} />
          <Stat label="Cached input" value={formatTokens(report.totals.cacheReadTokens)} />
          <Stat label="Uncached input" value={formatTokens(report.totals.inputTokens)} />
          <Stat label="Output" value={formatTokens(report.totals.outputTokens)} />
          <Stat label="Cache create" value={formatTokens(report.totals.cacheCreationTokens)} />
        </dl>
      </div>

      {shares.length > 0 ? (
        <div>
          <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">Breakdown</h3>
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
