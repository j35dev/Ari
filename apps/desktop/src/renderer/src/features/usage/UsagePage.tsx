import { useCallback, useState } from 'react'
import { Play } from 'lucide-react'
import { Button } from '@ari/ui/button'
import { rpc } from '../../lib/rpc'
import { UsageDashboard } from './UsageDashboard'

/**
 * Full-page usage view (M23.14): the per-session dashboard on top, plus the
 * community `ccusage` report (daily cost tables parsed from the local Claude
 * Code JSONL) run out-of-process on demand. Nothing is preinstalled — npx
 * resolves the package on first run, so the first invocation can be slow.
 */
export function UsagePage() {
  const [output, setOutput] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (): Promise<void> => {
    setRunning(true)
    setError(null)
    try {
      const result = await rpc.invoke('usage.ccusage', { subcommand: 'daily' })
      setOutput(result.output)
      if (!result.ok) setError(result.error ?? 'ccusage failed.')
    } catch {
      setError('Could not run ccusage.')
    } finally {
      setRunning(false)
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
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium text-fg">ccusage report</h2>
            <p className="text-2xs text-fg-subtle">
              Daily cost breakdown from the local Claude Code logs, via the community ccusage CLI.
            </p>
          </div>
          {running ? (
            <span role="status" className="text-2xs text-fg-subtle">running…</span>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => void run()}>
              <Play size={12} /> {output === null ? 'Run ccusage' : 'Re-run'}
            </Button>
          )}
        </div>

        {running && (
          <p role="status" className="text-xs text-fg-muted">
            Running ccusage… (first run downloads the package, this can take a minute)
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
