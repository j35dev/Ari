import { useCallback, useEffect, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { ProviderAccountRow, ProvidersUpdateFrame } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { accountIdentityLine } from './account-identity-line'

export interface AccountSwitchProps {
  kind: DriverKind
  /** Provider name for the group's accessible label, e.g. "Claude". */
  name: string
  /** Called once the provider runs as another account, e.g. to re-read its usage. */
  onSwitched?: () => void
}

/**
 * One button per account of a provider, the one in use pressed. For places
 * where the question is "which account am I burning", such as beside its usage
 * bars; adding and signing in stay in Settings. Renders nothing until a
 * provider has a second account.
 */
export function AccountSwitch({ kind, name, onSwitched }: AccountSwitchProps) {
  const [accounts, setAccounts] = useState<ProviderAccountRow[]>([])
  const [switching, setSwitching] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback((): void => {
    // Names only: opening a usage popover must not start a CLI per provider.
    rpc.invoke('providers.accounts', { kind, brief: true }).then(
      (result) => setAccounts(result.supported ? result.accounts : []),
      () => setAccounts([]),
    )
  }, [kind])

  useEffect(() => {
    load()
    return rpc.subscribe('providers.updates', {}, (payload) => {
      const frame = payload as ProvidersUpdateFrame
      if (frame.type === 'accounts' && frame.kind === kind) load()
    })
  }, [kind, load])

  if (accounts.length < 2) return null

  const use = async (id: string): Promise<void> => {
    setSwitching(id)
    setFailed(false)
    try {
      const result = await rpc.invoke('providers.accounts.activate', { kind, id })
      setAccounts(result.accounts)
      if (result.error === undefined) onSwitched?.()
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setSwitching(null)
    }
  }

  return (
    <div className="mb-2">
      <div role="group" aria-label={`${name} account`} className="flex flex-wrap gap-1">
        {accounts.map((account) => (
          <button
            key={account.id}
            type="button"
            aria-pressed={account.active}
            disabled={switching !== null}
            title={account.identity === null ? undefined : accountIdentityLine(account, false)}
            onClick={() => {
              if (!account.active) void use(account.id)
            }}
            className={`max-w-full truncate rounded-full border px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-60 ${
              account.active
                ? 'border-accent/50 bg-accent-subtle font-medium text-fg'
                : 'border-border text-fg-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            {account.label}
          </button>
        ))}
      </div>
      {failed && (
        <p role="status" className="mt-1 text-[11px] text-fg-muted">
          Could not switch account.
        </p>
      )}
    </div>
  )
}
