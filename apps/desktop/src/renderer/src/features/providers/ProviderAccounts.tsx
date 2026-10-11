import { useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import { Badge } from '@ari/ui/badge'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { Spinner } from '@ari/ui/spinner'
import { accountIdentityLine } from './account-identity-line'
import { useProviderAccounts } from './use-provider-accounts'

export interface ProviderAccountsProps {
  kind: DriverKind
  /** Provider name, e.g. "Claude". */
  name: string
  /** Switches the app to the Terminal pane, where a sign-in runs. */
  onOpenTerminal?: (() => void) | undefined
}

/**
 * The accounts a provider can run as. Each keeps its own sign-in, made and
 * removed by the provider's CLI; conversations, skills and settings are shared,
 * so a session can carry on as another account. What a CLI keeps beside its
 * sign-in (for Claude, MCP servers added per user) is per account.
 * Renders nothing for a provider whose sign-in cannot be kept per account.
 */
export function ProviderAccounts({ kind, name, onOpenTerminal }: ProviderAccountsProps) {
  const accounts = useProviderAccounts(kind, onOpenTerminal)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)

  if (accounts.supported !== true) return null

  const create = async (): Promise<void> => {
    const id = await accounts.add(label)
    if (id === null) return
    setAdding(false)
    setLabel('')
    // A new account is no use until it is signed in, so go straight there.
    await accounts.signIn(id)
  }

  return (
    <section aria-label="Accounts" className="border-t border-border/60 px-5 py-4">
      <h3 className="mb-3 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
        Accounts
      </h3>
      <ul className="flex flex-col gap-1.5">
        {accounts.accounts.map((account) => {
          const working = accounts.busy === account.id
          const signedIn = account.identity?.signedIn === true
          return (
            <li
              key={account.id}
              aria-label={`${account.label} account`}
              className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 ${
                account.active ? 'border-accent/50 bg-accent-subtle' : 'border-border/60 bg-surface-0'
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium text-fg">
                  <span className="truncate">{account.label}</span>
                  {account.active && <Badge tone="accent">In use</Badge>}
                </p>
                <p className="mt-0.5 truncate text-xs text-fg-muted">
                  {accountIdentityLine(account, accounts.signingIn === account.id)}
                </p>
              </div>
              {removing === account.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-fg-muted">Delete this sign-in?</span>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={working}
                    onClick={() => {
                      setRemoving(null)
                      void accounts.remove(account.id)
                    }}
                  >
                    Remove
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  {working && <Spinner className="h-3 w-3" />}
                  {!account.active && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={accounts.busy !== null}
                      aria-label={`Use ${account.label}`}
                      onClick={() => void accounts.activate(account.id)}
                    >
                      Use
                    </Button>
                  )}
                  {signedIn ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={accounts.busy !== null}
                      aria-label={`Sign out of ${account.label}`}
                      onClick={() => void accounts.signOut(account.id)}
                    >
                      Sign out
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={account.active ? 'primary' : 'ghost'}
                      disabled={accounts.busy !== null}
                      aria-label={`Sign in to ${account.label}`}
                      onClick={() => void accounts.signIn(account.id)}
                    >
                      Sign in
                    </Button>
                  )}
                  {!account.isDefault && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={accounts.busy !== null}
                      aria-label={`Remove ${account.label}`}
                      onClick={() => setRemoving(account.id)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {accounts.error !== null && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {accounts.error}
        </p>
      )}

      {adding ? (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Input
            autoFocus
            aria-label="Account name"
            placeholder="e.g. Work"
            maxLength={40}
            value={label}
            className="min-w-0 flex-1"
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setAdding(false)
            }}
          />
          <Button
            size="sm"
            type="submit"
            disabled={label.trim().length === 0 || accounts.busy !== null}
          >
            {accounts.busy === 'add' ? <Spinner className="h-3 w-3" /> : null} Add and sign in
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => setAdding(true)}>
          Add account
        </Button>
      )}

      <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
        New turns run as the account in use. Each account keeps its own {name} sign-in;
        conversations, skills and settings are shared, so a session carries on after you switch.
      </p>
    </section>
  )
}
