import { useEffect, useState } from 'react'
import { rpc } from '../../lib/rpc'
import { UsageDashboard } from './UsageDashboard'

/**
 * Full-page usage view: Ari's own token/cost dashboard, plus the community
 * ccusage report which starts automatically on open.
 */
export function UsagePage() {
  const [output, setOutput] = useState<string | null>(null)
  const [running, setRunning] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void rpc
      .invoke('usage.ccusage', { subcommand: 'daily' })
      .then((result) => {
        if (cancelled) return
        setOutput(result.output)
        if (!result.ok) setError(result.error ?? 'ccusage failed.')
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
    <div className="ari-scroll flex h-full flex-col gap-4 overflow-y-auto p-6">
      <header>
        <h1 className="text-base font-semibold text-fg">Usage</h1>
        <p className="text-xs text-fg-subtle">Token and cost totals across your sessions.</p>
      </header>

      <UsageDashboard />

      <section aria-label="ccusage report" className="flex flex-col gap-2">
        <div>
          <h2 className="text-sm font-medium text-fg">ccusage</h2>
          <p className="text-2xs text-fg-subtle">Daily cost from local Claude Code logs.</p>
        </div>
        {running && (
          <p role="status" className="text-xs text-fg-muted">
            Loading ccusage…
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {output !== null && !running && (
          <pre
            aria-label="ccusage output"
            className="ari-scroll max-h-[60vh] overflow-auto rounded-md border border-border bg-surface-0 p-3 font-mono text-2xs leading-4 text-fg-muted"
          >
            {output}
          </pre>
        )}
      </section>
    </div>
  )
}
