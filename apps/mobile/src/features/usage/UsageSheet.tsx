import { useEffect, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import type { RemoteAllowance } from '@ari/contracts/remote'
import { providerName } from '../../components/ModelPicker'
import { BottomSheet } from '../../components/ui'
import { countdown, relativeTime } from '../../lib/format'
import { useAllowance } from '../../lib/use-allowance'

function stale(row: RemoteAllowance, now: number): boolean {
  return (
    row.status === 'error' ||
    row.windows.some((window) => window.resetsAt !== null && window.resetsAt <= now)
  )
}

function names(kinds: string[]): string {
  return kinds.map(providerName).join(', ')
}

/**
 * Every installed provider's account allowance, the open session's provider
 * first, with the two things to do about a limit: run the provider as another
 * of its accounts, and spend a banked reset. Both happen on the computer.
 */
export function UsageSheet({
  current,
  onClose,
}: {
  current?: string
  onClose: () => void
}): ReactNode {
  const { kinds, rows, accounts, refreshing, canRedeem, refresh, switchAccount, redeem } =
    useAllowance()
  const [now, setNow] = useState(Date.now)
  /** The provider an action is running for; one at a time keeps the sheet honest. */
  const [working, setWorking] = useState<string | null>(null)
  /** The provider whose reset is one tap from being spent. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({})
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])

  const note = (kind: string, value: { ok: boolean; text: string } | null): void =>
    setNotes((previous) => {
      const next = { ...previous }
      if (value === null) delete next[kind]
      else next[kind] = value
      return next
    })

  const use = async (kind: string, accountId: string): Promise<void> => {
    setWorking(kind)
    setConfirming(null)
    note(kind, null)
    const problem = await switchAccount(kind, accountId)
    if (problem !== null) note(kind, { ok: false, text: problem })
    setWorking(null)
  }

  const spend = async (kind: string): Promise<void> => {
    setWorking(kind)
    setConfirming(null)
    note(kind, await redeem(kind))
    setWorking(null)
  }

  const ordered = [...kinds].sort((a, b) => Number(b === current) - Number(a === current))
  // A provider with a choice of accounts is never hidden: the account in use
  // may be the one with nothing to show, and this is where to leave it.
  const quiet = ordered.filter((kind) => {
    const row = rows[kind]
    return (
      row !== undefined &&
      row.windows.length === 0 &&
      row.bankedResets === 0 &&
      accounts[kind] === undefined
    )
  })
  const unread = quiet.filter((kind) => rows[kind]?.status === 'error')
  const unreported = quiet.filter((kind) => rows[kind]?.status !== 'error')
  return (
    <BottomSheet title="Usage" onClose={onClose}>
      <div className="-mt-2 flex items-center justify-between gap-3 text-xs text-fg-subtle">
        <span>Plan allowance · refreshes every minute</span>
        <button
          type="button"
          className="icon-button text-fg-muted"
          aria-label="Refresh usage"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="divide-y divide-border">
        {ordered.map((kind) => {
          const row = rows[kind]
          const name = providerName(kind)
          const list = accounts[kind]
          // In its own place, so the list does not jump when a slow provider answers.
          if (row === undefined)
            return (
              <p key={kind} role="status" className="py-4 text-sm text-fg-muted">
                Checking {name}…
              </p>
            )
          if (quiet.includes(kind)) return null
          const old = stale(row, now)
          const active = list?.find((account) => account.active)
          const busy = working !== null
          return (
            <section key={row.driverKind} aria-label={`${name} usage`} className="py-4">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-[15px] font-medium">
                  {name}
                  {row.driverKind === current && (
                    <span className="ml-2 text-xs font-normal text-fg-subtle">This session</span>
                  )}
                </h3>
                {old && (
                  <span className="shrink-0 text-xs text-fg-subtle">
                    {row.updatedAt === null
                      ? 'Stale'
                      : `Stale · ${relativeTime(row.updatedAt, now)}`}
                  </span>
                )}
              </div>
              {list !== undefined && (
                <>
                  <div
                    role="group"
                    aria-label={`${name} account`}
                    className="mt-3 flex flex-wrap gap-2"
                  >
                    {list.map((account) => (
                      <button
                        key={account.id}
                        type="button"
                        aria-pressed={account.active}
                        disabled={busy}
                        onClick={() => {
                          if (!account.active) void use(kind, account.id)
                        }}
                        className={`control-chip ${account.active ? 'bg-accent-subtle font-medium text-fg ring-1 ring-accent/50' : ''}`}
                      >
                        {account.label}
                      </button>
                    ))}
                  </div>
                  {active?.signedIn === false && (
                    <p className="mt-2 text-xs text-warning">
                      {active.label} is not signed in. Sign it in on your computer, or use another
                      account.
                    </p>
                  )}
                </>
              )}
              {row.windows.map((window) => (
                <div key={window.label} className="mt-3">
                  <div className="flex justify-between gap-3 text-[13px] text-fg-muted">
                    <span>{window.label}</span>
                    <span className="font-mono tabular-nums text-fg">
                      {Math.round(window.usedPercent)}% used
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={`${name} ${window.label} used`}
                    aria-valuenow={Math.round(window.usedPercent)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2"
                  >
                    <div
                      className={`h-full rounded-full ${old ? 'bg-fg-subtle' : window.usedPercent >= 90 ? 'bg-danger' : window.usedPercent >= 75 ? 'bg-warning' : 'bg-accent'}`}
                      style={{ width: `${window.usedPercent}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-fg-subtle">
                    {window.resetsAt !== null
                      ? window.resetsAt <= now
                        ? 'Reset due · waiting for a fresh reading'
                        : `Resets in ${countdown(window.resetsAt - now)}`
                      : window.resetText
                        ? `Resets ${window.resetText}`
                        : 'Reset time unavailable'}
                  </p>
                </div>
              ))}
              {row.windows.length === 0 && working !== kind && (
                <p className="mt-3 text-xs text-fg-subtle">No usage reported for this account.</p>
              )}
              {working === kind && (
                <p role="status" className="mt-3 text-xs text-fg-muted">
                  Working on your computer…
                </p>
              )}
              {row.bankedResets > 0 &&
                (!canRedeem ? (
                  <p className="mt-3 text-xs text-fg-muted">
                    {row.bankedResets} {row.bankedResets === 1 ? 'reset' : 'resets'} banked · use{' '}
                    {row.bankedResets === 1 ? 'it' : 'them'} on your computer
                  </p>
                ) : confirming === kind ? (
                  <div className="mt-3 rounded-xl border border-border bg-surface-1 p-3">
                    <p className="text-[13px] text-fg">
                      Use one of your {row.bankedResets} banked{' '}
                      {row.bankedResets === 1 ? 'reset' : 'resets'} now? It clears the current limit
                      and cannot be taken back.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        className="secondary-button flex-1"
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="primary-button min-h-11 flex-1"
                        onClick={() => void spend(kind)}
                      >
                        Use reset
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-xs text-fg-muted">
                      {row.bankedResets} {row.bankedResets === 1 ? 'reset' : 'resets'} banked
                    </span>
                    <button
                      type="button"
                      className="control-chip"
                      disabled={busy}
                      aria-label={`Use a ${name} reset`}
                      onClick={() => {
                        note(kind, null)
                        setConfirming(kind)
                      }}
                    >
                      Use a reset
                    </button>
                  </div>
                ))}
              {notes[kind] !== undefined && (
                <p
                  role="status"
                  className={`mt-3 text-xs ${notes[kind].ok ? 'text-fg-muted' : 'text-danger'}`}
                >
                  {notes[kind].text}
                </p>
              )}
            </section>
          )
        })}
      </div>
      {kinds.length === 0 && (
        <p className="py-3 text-sm text-fg-muted">No providers found on your computer.</p>
      )}
      {unread.length > 0 && (
        <p role="status" className="py-2 text-xs text-fg-subtle">
          Could not read {names(unread)}. Trying again shortly.
        </p>
      )}
      {unreported.length > 0 && (
        <p className="py-2 text-xs text-fg-subtle">No usage reported by {names(unreported)}.</p>
      )}
    </BottomSheet>
  )
}
