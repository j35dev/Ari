import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteAllowance } from '@ari/contracts/remote'
import { useApp } from './app-state'

const REFRESH_MS = 60_000

/**
 * Account allowance for every provider installed on the computer, read one
 * provider at a time so a slow one holds up only its own row. Each read starts
 * that provider's CLI on the desktop, so this runs only while something is
 * showing the result.
 */
export function useAllowance(): {
  kinds: string[]
  rows: Record<string, RemoteAllowance>
  refreshing: boolean
  refresh: () => Promise<void>
} {
  const app = useApp()
  const session = app.session
  // Ari Core bills through the user's own endpoint and has no account allowance.
  const key = (app.catalog?.providers ?? [])
    .filter((provider) => provider.installed !== false && provider.driverKind !== 'ari-core')
    .map((provider) => provider.driverKind)
    .join(',')
  const [rows, setRows] = useState<Record<string, RemoteAllowance>>({})
  const [refreshing, setRefreshing] = useState(false)
  const generation = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (session === null || key === '') return
    const current = ++generation.current
    setRefreshing(true)
    await Promise.all(
      key.split(',').map(async (driverKind) => {
        let next: RemoteAllowance | null = null
        try {
          next = await session.query<RemoteAllowance | null>('usage.allowance', { driverKind })
        } catch (failure) {
          console.warn('Ari could not read provider usage', failure)
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
      }),
    )
    if (current === generation.current) setRefreshing(false)
  }, [session, key])

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

  return { kinds: key === '' ? [] : key.split(','), rows, refreshing, refresh }
}
