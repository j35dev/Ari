import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteAccounts, RemoteAllowance, RemoteRedeem } from '@ari/contracts/remote'
import { useApp } from './app-state'

const REFRESH_MS = 60_000

type Account = RemoteAccounts['accounts'][number]

/** What the desktop said about one use of a banked reset, in words for the sheet. */
const REDEEMED: Record<RemoteRedeem['outcome'], string> = {
  reset: 'Reset applied.',
  nothingToReset: 'Nothing to reset: this account is not limited right now.',
  noCredit: 'No reset left to use.',
  alreadyRedeemed: 'That reset was already used.',
}

const failure = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.length > 0 ? error.message : fallback

/**
 * Account allowance for every provider installed on the computer, read one
 * provider at a time so a slow one holds up only its own row. Each read starts
 * that provider's CLI on the desktop, so this runs only while something is
 * showing the result.
 *
 * Where the desktop offers them, it also carries each provider's accounts and
 * the two things a phone may do about a limit: run the provider as another
 * account, and spend a banked reset. Both act on the computer, not on one
 * session, and both answer with the state they left behind.
 */
export function useAllowance(): {
  kinds: string[]
  rows: Record<string, RemoteAllowance>
  /** Per provider; only present where there is more than the one default account. */
  accounts: Record<string, Account[]>
  refreshing: boolean
  /** False on a desktop too old to redeem for a phone; the sheet then says where to. */
  canRedeem: boolean
  refresh: () => Promise<void>
  /** Resolves to why the switch did not happen, or null when it did. */
  switchAccount: (driverKind: string, accountId: string) => Promise<string | null>
  /** Resolves to a sentence about what happened to the reset. */
  redeem: (driverKind: string) => Promise<{ ok: boolean; text: string }>
} {
  const app = useApp()
  const session = app.session
  // Ari Core bills through the user's own endpoint and has no account allowance.
  const key = (app.catalog?.providers ?? [])
    .filter((provider) => provider.installed !== false && provider.driverKind !== 'ari-core')
    .map((provider) => provider.driverKind)
    .join(',')
  const [rows, setRows] = useState<Record<string, RemoteAllowance>>({})
  const [accounts, setAccounts] = useState<Record<string, Account[]>>({})
  const [refreshing, setRefreshing] = useState(false)
  const generation = useRef(0)
  const listsAccounts = session?.supports('accounts.list') === true

  const readAllowance = useCallback(
    async (driverKind: string, current: number): Promise<void> => {
      if (session === null) return
      let next: RemoteAllowance | null = null
      try {
        next = await session.query<RemoteAllowance | null>('usage.allowance', { driverKind })
      } catch (failed) {
        console.warn('Ari could not read provider usage', failed)
      }
      if (current !== generation.current) return
      setRows((previous) => {
        const last = previous[driverKind]
        // A failed read keeps the last numbers and marks them stale.
        const row = next ?? {
          driverKind: driverKind as RemoteAllowance['driverKind'],
          windows: last?.windows ?? [],
          bankedResets: last?.bankedResets ?? 0,
          updatedAt: last?.updatedAt ?? null,
          status: 'error' as const,
        }
        return { ...previous, [driverKind]: row }
      })
    },
    [session],
  )

  const refresh = useCallback(async (): Promise<void> => {
    if (session === null || key === '') return
    const current = ++generation.current
    setRefreshing(true)
    await Promise.all(
      key.split(',').flatMap((driverKind) => [
        readAllowance(driverKind, current),
        listsAccounts
          ? session.query<RemoteAccounts>('accounts.list', { driverKind }).then(
              (result) => {
                if (current !== generation.current) return
                setAccounts((previous) => ({ ...previous, [driverKind]: result.accounts }))
              },
              (failed: unknown) => console.warn('Ari could not read provider accounts', failed),
            )
          : Promise.resolve(),
      ]),
    )
    if (current === generation.current) setRefreshing(false)
  }, [session, key, listsAccounts, readAllowance])

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, REFRESH_MS)
    return () => {
      clearInterval(interval)
      generation.current++
    }
  }, [refresh])

  const switchAccount = useCallback(
    async (driverKind: string, accountId: string): Promise<string | null> => {
      if (session === null) return 'Not connected to your computer.'
      try {
        const result = (await session.send({
          op: 'accounts.activate',
          driverKind,
          accountId,
        })) as RemoteAccounts
        setAccounts((previous) => ({ ...previous, [driverKind]: result.accounts }))
      } catch (failed) {
        return failure(failed, 'Could not switch account.')
      }
      // The bars on screen are the other account's, not a stale reading of this one.
      setRows((previous) => {
        const next = { ...previous }
        delete next[driverKind]
        return next
      })
      await readAllowance(driverKind, generation.current)
      return null
    },
    [session, readAllowance],
  )

  const redeem = useCallback(
    async (driverKind: string): Promise<{ ok: boolean; text: string }> => {
      if (session === null) return { ok: false, text: 'Not connected to your computer.' }
      try {
        const result = (await session.send({ op: 'usage.redeem', driverKind })) as RemoteRedeem
        setRows((previous) => ({ ...previous, [driverKind]: result.allowance }))
        return { ok: true, text: REDEEMED[result.outcome] }
      } catch (failed) {
        return { ok: false, text: failure(failed, 'Could not use the reset.') }
      }
    },
    [session],
  )

  return {
    kinds: key === '' ? [] : key.split(','),
    rows,
    accounts: Object.fromEntries(
      Object.entries(accounts).filter(([, list]) => list.length > 1),
    ),
    refreshing,
    canRedeem: session?.supports('usage.redeem') === true,
    refresh,
    switchAccount,
    redeem,
  }
}
