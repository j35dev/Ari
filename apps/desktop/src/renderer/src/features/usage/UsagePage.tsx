import { useEffect, useState } from 'react'
import { rpc } from '../../lib/rpc'
import { CcusageDashboard } from './CcusageDashboard'
import { isoDate, parseCcusageJson, type CcusageReport, type Granularity } from './parse-ccusage'

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]

const RANGES: { value: number | null; label: string }[] = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 60, label: '60d' },
  { value: 90, label: '90d' },
  { value: null, label: 'All' },
]

/** Segmented chip row shared by the granularity and range switchers. */
function Segmented<T>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (next: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-surface-1 p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`rounded-sm px-2 py-0.5 text-2xs transition-colors duration-[var(--ari-dur-fast)] motion-reduce:transition-none ${
              active ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:text-fg'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Full-page usage: the parsed ccusage report with granularity (daily /
 * weekly / monthly) and time-window switchers. ccusage `daily --json` runs
 * once and every view is derived from those rows client-side; the Ari session
 * feed is gone — ccusage is the source of truth here.
 */
export function UsagePage() {
  const [report, setReport] = useState<CcusageReport | null>(null)
  const [running, setRunning] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [granularity, setGranularity] = useState<Granularity>('daily')
  const [rangeDays, setRangeDays] = useState<number | null>(30)

  useEffect(() => {
    let cancelled = false
    void rpc
      .invoke('usage.ccusage', { subcommand: 'daily' })
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setError(result.error ?? 'ccusage failed.')
          return
        }
        const parsed = parseCcusageJson(result.output)
        if (parsed === null) {
          setError('ccusage returned data Ari could not read.')
          return
        }
        setReport(parsed)
      })
      .catch(() => {
        if (!cancelled) setError('Could not run ccusage.')
      })
      .finally(() => {
        if (!cancelled) setRunning(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const since =
    rangeDays === null ? null : isoDate(new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000))

  return (
    <div className="ari-scroll flex h-full flex-col gap-8 overflow-y-auto p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-fg">Usage</h1>
          <p className="text-xs text-fg-subtle">
            Tokens and costs parsed from your local agent transcripts (ccusage).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Granularity"
            options={GRANULARITIES}
            value={granularity}
            onChange={setGranularity}
          />
          <Segmented
            label="Time window"
            options={RANGES}
            value={rangeDays}
            onChange={setRangeDays}
          />
        </div>
      </header>

      <section aria-label="ccusage report" className="flex flex-col gap-3">
        {running && (
          <p role="status" className="text-xs text-fg-muted">
            Loading usage…
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {report !== null && !running ? (
          <CcusageDashboard report={report} granularity={granularity} since={since} />
        ) : null}
      </section>
    </div>
  )
}
