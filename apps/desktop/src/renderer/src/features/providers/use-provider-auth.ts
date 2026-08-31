import { useCallback, useEffect, useRef, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { ProviderLoginMethod, ProvidersUpdateFrame, RpcResults } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'

export type AuthProbeResult = RpcResults['providers.authProbe']

/** What the UI knows about one provider's sign-in, and how it learned it. */
export interface ProviderAuthEntry {
  /** From a refused turn (`live`) or from an explicit preflight (`probe`). */
  source: 'live' | 'probe'
  result: AuthProbeResult
}

export type ProviderAuthStates = Partial<Record<DriverKind, ProviderAuthEntry>>

/**
 * Tracks per-provider sign-in state for the settings grid.
 *
 * Nothing is probed on mount: a preflight spawns a real adapter, and doing that
 * for every provider whenever Settings opens would be slow and pointless for
 * agents that are working fine. State arrives either because the user asked
 * (`check`) or because a turn was actually refused — the `auth.required` frame,
 * which is free and is the only moment the user cares about.
 */
export function useProviderAuth(): {
  auth: ProviderAuthStates
  checking: Partial<Record<DriverKind, boolean>>
  check: (kind: DriverKind) => Promise<void>
  loginsFor: (kind: DriverKind) => Promise<ProviderLoginMethod[]>
  dismiss: (kind: DriverKind) => void
} {
  const [auth, setAuth] = useState<ProviderAuthStates>({})
  const [checking, setChecking] = useState<Partial<Record<DriverKind, boolean>>>({})
  // Kept in a ref so the stream subscription never needs to re-subscribe.
  const authRef = useRef(auth)
  authRef.current = auth

  useEffect(() => {
    const unsubscribe = rpc.subscribe('providers.updates', {}, (payload) => {
      const frame = payload as ProvidersUpdateFrame
      if (frame.type !== 'auth.required') return
      setAuth((current) => ({
        ...current,
        [frame.kind]: {
          source: 'live',
          result: { status: 'auth-required', label: frame.label, logins: frame.logins },
        },
      }))
    })
    return unsubscribe
  }, [])

  const check = useCallback(async (kind: DriverKind): Promise<void> => {
    setChecking((current) => ({ ...current, [kind]: true }))
    try {
      const result = await rpc.invoke('providers.authProbe', { kind })
      setAuth((current) => ({ ...current, [kind]: { source: 'probe', result } }))
    } catch {
      setAuth((current) => ({
        ...current,
        [kind]: {
          source: 'probe',
          result: { status: 'unknown', reason: 'Ari could not check this provider’s sign-in.' },
        },
      }))
    } finally {
      setChecking((current) => ({ ...current, [kind]: false }))
    }
  }, [])

  const loginsFor = useCallback(async (kind: DriverKind): Promise<ProviderLoginMethod[]> => {
    const known = authRef.current[kind]?.result
    if (known?.status === 'auth-required' && known.logins.length > 0) return known.logins
    try {
      return (await rpc.invoke('providers.login', { kind })).logins
    } catch {
      return []
    }
  }, [])

  const dismiss = useCallback((kind: DriverKind): void => {
    setAuth((current) => {
      const next = { ...current }
      delete next[kind]
      return next
    })
  }, [])

  return { auth, checking, check, loginsFor, dismiss }
}
