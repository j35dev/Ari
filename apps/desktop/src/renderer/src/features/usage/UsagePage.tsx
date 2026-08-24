import { useEffect, useState } from 'react'
import { rpc } from '../../lib/rpc'
import { UsageDashboard } from './UsageDashboard'
import { CcusageDashboard } from './CcusageDashboard'
import { parseCcusageJson, type CcusageReport } from './parse-ccusage'

/**
 * Full-page usage: Ari session rows (clickable) plus a parsed ccusage
 * dashboard. ccusage starts automatically; JSON is preferred over the log dump.
 */
export function UsagePage({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const [report, setReport] = useState<CcusageReport | null>(null)
  const [running, setRunning] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className="ari-scroll flex h-full flex-col gap-8 overflow-y-auto p-6">
      <header>
        <h1 className="text-base font-semibold text-fg">Usage</h1>
        <p className="text-xs text-fg-subtle">Token and cost totals across your sessions.</p>
      </header>

      <UsageDashboard onOpenSession={onOpenSession} />

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
        {report !== null && !running ? <CcusageDashboard report={report} /> : null}
      </section>
    </div>
  )
}
