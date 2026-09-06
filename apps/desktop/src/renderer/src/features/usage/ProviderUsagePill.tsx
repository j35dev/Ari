import { useEffect, useState } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { Popover } from '@ari/ui/popover'
import type { DriverKind } from '@ari/contracts/common'
import type { ProviderAllowance } from '@ari/contracts/rpc'
import { useProviderAllowance } from './use-provider-allowance'

const NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  pi: 'Pi',
  hermes: 'Hermes',
  'ari-core': 'Ari Core',
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
}

function stale(row: ProviderAllowance | undefined, now: number): boolean {
  return (
    !!row && row.windows.length > 0 &&
    (row.status === 'error' ||
      (row.updatedAt !== null && now - row.updatedAt > 90_000) ||
      row.windows.some((window) => window.resetsAt !== null && window.resetsAt <= now))
  )
}

/** Always-visible account allowance for the session, with all installed providers one click away. */
export function ProviderUsagePill({
  sessionId,
  kind,
}: {
  sessionId: string | null
  kind: DriverKind
}) {
  const { rows, refreshing, error, refresh } = useProviderAllowance(sessionId, kind)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const selected = rows.find((row) => row.kind === kind)
  const primary =
    selected?.windows.find((window) => window.label === '5h') ??
    selected?.windows.find((window) => window.label === 'Weekly') ??
    selected?.windows[0]
  const used = primary ? Math.round(primary.usedPercent) : null
  const outdated = stale(selected, now)
  const label = NAMES[kind] ?? kind
  const tone = outdated
    ? 'text-fg-subtle'
    : used !== null && used >= 90
      ? 'text-danger'
      : used !== null && used >= 75
        ? 'text-warning'
        : 'text-accent'

  return (
    <div className="mr-2 shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) void refresh()
        }}
      >
        <Popover.Trigger
          aria-label={`${label} usage: ${used === null ? 'unavailable' : `${primary?.label} ${used}% used${outdated ? ', stale' : ''}`}`}
          className="flex h-6 items-center gap-1.5 rounded-full border border-border bg-surface-1 px-2 text-[11px] text-fg-muted transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <svg viewBox="0 0 16 16" className={`size-3.5 ${tone}`} aria-hidden="true">
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              opacity="0.2"
            />
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              pathLength="100"
              strokeDasharray={`${used ?? 0} 100`}
              strokeLinecap="round"
              transform="rotate(-90 8 8)"
            />
          </svg>
          <span>{label}</span>
          <span className="font-mono tabular-nums text-fg">
            {primary
              ? `${primary.label} · ${used}% used`
              : refreshing && !selected?.checkedAt
                ? '…'
                : '—'}
          </span>
          {outdated ? <span title="Last known usage; awaiting a fresh reading">·</span> : null}
          <ChevronDown size={11} aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Content
          align="end"
          aria-label="Provider usage"
          className="w-72 max-w-[calc(100vw-24px)] !p-0"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-fg">Provider usage</span>
            <button
              type="button"
              aria-label="Refresh usage"
              disabled={refreshing}
              onClick={() => void refresh()}
              className="rounded p-1 text-fg-subtle hover:text-fg focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40"
            >
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          </div>
          <div className="max-h-[min(65vh,480px)] overflow-y-auto px-3">
            {rows.map((row) => (
              <div key={row.kind} className="border-b border-border py-3 last:border-0">
                <div className="mb-2 flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-medium text-fg">
                    {NAMES[row.kind] ?? row.kind}
                    {row.kind === kind ? (
                      <span className="ml-1.5 text-fg-subtle">· current</span>
                    ) : null}
                  </span>
                  <span className="text-fg-subtle">
                    {stale(row, now)
                      ? 'Stale'
                      : row.updatedAt !== null
                        ? now - row.updatedAt < 60_000
                          ? 'Just updated'
                          : `${Math.floor((now - row.updatedAt) / 60_000)}m ago`
                        : ''}
                  </span>
                </div>
                {row.windows.length ? (
                  row.windows.map((window) => (
                    <div key={window.label} className="mt-2">
                      <div className="mb-1 flex justify-between text-[11px] text-fg-muted">
                        <span>{window.label}</span>
                        <span className="font-mono tabular-nums">
                          {Math.round(window.usedPercent)}% used
                        </span>
                      </div>
                      <div
                        role="progressbar"
                        aria-label={`${NAMES[row.kind] ?? row.kind} ${window.label} used`}
                        aria-valuenow={window.usedPercent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        className="h-1 overflow-hidden rounded-full bg-surface-3"
                      >
                        <div
                          className={`h-full rounded-full ${stale(row, now) ? 'bg-fg-subtle' : window.usedPercent >= 90 ? 'bg-danger' : 'bg-accent'}`}
                          style={{ width: `${window.usedPercent}%` }}
                        />
                      </div>
                      <div className="mt-1 text-[10px] text-fg-subtle">
                        {window.resetsAt !== null
                          ? window.resetsAt <= now
                            ? 'Reset due · awaiting refresh'
                            : `Resets in ${duration(window.resetsAt - now)}`
                          : window.resetText
                            ? `Resets ${window.resetText}`
                            : 'Reset time unavailable'}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-[11px] text-fg-subtle" title={row.detail}>
                    {!row.checkedAt && refreshing ? 'Checking usage…' : 'Usage unavailable'}
                  </p>
                )}
                {row.status === 'error' ? (
                  <p className="mt-1 text-[10px] text-fg-subtle">
                    Refresh failed · retrying automatically
                  </p>
                ) : null}
              </div>
            ))}
            {!rows.length ? (
              <p className="py-3 text-xs text-fg-subtle">
                {refreshing ? 'Checking providers…' : 'No providers detected'}
              </p>
            ) : null}
            {error ? (
              <p role="status" className="py-2 text-xs text-fg-muted">
                Could not refresh providers.
              </p>
            ) : null}
          </div>
          <p className="border-t border-border px-3 py-2 text-[10px] text-fg-subtle">
            Allowance used · refreshes every minute
          </p>
        </Popover.Content>
      </Popover>
    </div>
  )
}
