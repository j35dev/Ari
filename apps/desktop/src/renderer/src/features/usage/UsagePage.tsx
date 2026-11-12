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
      className="inline-flex items-center rounded-lg bg-surface-2 p-[3px]"
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex h-6 items-center justify-center whitespace-nowrap rounded-md px-2.5 text-[13px] transition-colors duration-[var(--ari-dur-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring motion-reduce:transition-none ${
              active ? 'bg-bg text-fg shadow-1' : 'text-fg-subtle hover:text-fg'
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
    <div className="ari-scroll h-full overflow-y-auto">
      {/* The settings column: 680px of content, 44px from the top of the stage. */}
      <div className="mx-auto flex w-full max-w-[744px] flex-col px-8 pb-16 pt-11">
        <header className="mb-[30px] flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.02em] text-fg">
              Usage
            </h1>
            <p className="mt-1 text-sm text-fg-subtle">
              Tokens and costs parsed from your local agent transcripts (ccusage).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
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
            <p role="status" className="text-[13px] text-fg-subtle">
              Loading usage…
            </p>
          )}
          {error !== null && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}
          {report !== null && !running ? (
            <CcusageDashboard report={report} granularity={granularity} since={since} />
          ) : null}
        </section>
      </div>
    </div>
  )
}
