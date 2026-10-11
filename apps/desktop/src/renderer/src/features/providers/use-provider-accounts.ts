import { useCallback, useEffect, useRef, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { ProviderAccountRow, ProvidersUpdateFrame, RpcResults } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { requestTerminalTab } from '../terminal/terminal-requests'
import { loginCommandLine } from './provider-login-command'

type Result = RpcResults['providers.accounts']

export interface ProviderAccountsState {
  /** Null until the first answer; `supported` is false for providers without accounts. */
  supported: boolean | null
  accounts: ProviderAccountRow[]
  /** The id of the account an action is running for, or `add` while one is created. */
  busy: string | null
  /** The id of the account whose sign-in is open in a terminal. */
  signingIn: string | null
  error: string | null
  /** Resolves to the new account's id, or null when it could not be created. */
  add: (label: string) => Promise<string | null>
  activate: (id: string) => Promise<void>
  signIn: (id: string) => Promise<void>
  signOut: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  refresh: () => Promise<void>
}

/**
 * The accounts one provider can run as, and the actions on them. Signing in
 * happens in the provider's own CLI in a terminal tab, and opening that tab
 * usually closes the view using this hook, so the main process is the one
 * that watches for the sign-in to finish; this only follows what it announces.
 */
export function useProviderAccounts(
  kind: DriverKind,
  onOpenTerminal?: () => void,
): ProviderAccountsState {
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)

  const adopt = useCallback((next: Result): void => {
    if (!live.current) return
    setResult(next)
    setError(next.error ?? null)
  }, [])

  const load = useCallback(
    async (fresh: boolean): Promise<Result | null> => {
      try {
        const next = await rpc.invoke('providers.accounts', { kind, fresh })
        // A reload reports no outcome, so it leaves the last action's alone.
        if (live.current) setResult(next)
        return next
      } catch {
        if (live.current) setError('Could not read this provider’s accounts.')
        return null
      }
    },
    [kind],
  )

  useEffect(() => {
    live.current = true
    void load(false)
    const unsubscribe = rpc.subscribe('providers.updates', {}, (payload) => {
      const frame = payload as ProvidersUpdateFrame
      if (frame.type === 'accounts' && frame.kind === kind) void load(false)
    })
    return () => {
      live.current = false
      unsubscribe()
    }
  }, [kind, load])

  useEffect(() => {
    if (signingIn === null) return
    const account = result?.accounts.find((entry) => entry.id === signingIn)
    if (account?.identity?.signedIn === true) setSigningIn(null)
  }, [result, signingIn])

  const run = useCallback(
    async (id: string, call: () => Promise<Result>): Promise<Result | null> => {
      setBusy(id)
      setError(null)
      try {
        const next = await call()
        adopt(next)
        return next.error === undefined ? next : null
      } catch {
        if (live.current) setError('That did not work. Try again.')
        return null
      } finally {
        if (live.current) setBusy(null)
      }
    },
    [adopt],
  )

  const signIn = useCallback(
    async (id: string): Promise<void> => {
      setBusy(id)
      setError(null)
      try {
        const [login, info] = await Promise.all([
          rpc.invoke('providers.accounts.signIn', { kind, id }),
          rpc.invoke('app.info'),
        ])
        if (login === null) {
          setError('This provider’s CLI is not available to sign in with.')
          return
        }
        requestTerminalTab({
          title: login.title,
          cwd: info.homeDir,
          command: loginCommandLine(login, info.platform, login.env),
        })
        setSigningIn(id)
        onOpenTerminal?.()
      } catch {
        if (live.current) setError('Could not open a terminal for the sign-in.')
      } finally {
        if (live.current) setBusy(null)
      }
    },
    [kind, onOpenTerminal],
  )

  return {
    supported: result?.supported ?? null,
    accounts: result?.accounts ?? [],
    busy,
    signingIn,
    error,
    add: async (label) => {
      const before = new Set(result?.accounts.map((account) => account.id))
      const next = await run('add', () => rpc.invoke('providers.accounts.add', { kind, label }))
      return next?.accounts.find((account) => !before.has(account.id))?.id ?? null
    },
    activate: async (id) => {
      await run(id, () => rpc.invoke('providers.accounts.activate', { kind, id }))
    },
    signIn,
    signOut: async (id) => {
      await run(id, () => rpc.invoke('providers.accounts.signOut', { kind, id }))
    },
    remove: async (id) => {
      await run(id, () => rpc.invoke('providers.accounts.remove', { kind, id }))
    },
    refresh: async () => {
      await load(true)
    },
  }
}
