import { useCallback, useEffect, useRef, useState } from 'react'
import { driverKindSchema } from '@ari/contracts/common'
import type { DriverKind } from '@ari/contracts/common'
import type { ProviderAllowance } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'

const log = createLogger('ui:allowance')

/** Refresh account quotas independently, keeping failures local to each provider. */
export function useProviderAllowance(sessionId: string | null, kind: DriverKind) {
  const [rows, setRows] = useState<ProviderAllowance[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const current = ++generation.current
    setRefreshing(true)
    setError(false)
    try {
      const detected = await rpc.invoke('providers.detect')
      if (current !== generation.current) return
      const kinds = detected
        .filter((row) => row.installed)
        .flatMap((row) => {
          const parsed = driverKindSchema.safeParse(row.kind)
          return parsed.success ? [parsed.data] : []
        })
      setRows((previous) =>
        kinds.map(
          (provider) =>
            previous.find((row) => row.kind === provider) ?? {
              kind: provider,
              status: 'unavailable',
              windows: [],
              updatedAt: null,
              checkedAt: 0,
              detail: '',
            },
        ),
      )
      await Promise.all(
        kinds.map(async (provider) => {
          try {
            const result = await rpc.invoke('providers.allowance', { kind: provider })
            if (current === generation.current)
              setRows((previous) => previous.map((row) => (row.kind === provider ? result : row)))
          } catch (failure) {
            log.warn('Usage refresh failed', failure)
            if (current === generation.current)
              setRows((previous) =>
                previous.map((row) =>
                  row.kind === provider
                    ? {
                        ...row,
                        status: 'error',
                        checkedAt: Date.now(),
                        detail: 'Could not refresh usage. Retrying automatically.',
                      }
                    : row,
                ),
              )
          }
        }),
      )
    } catch (failure) {
      log.warn('Provider discovery failed', failure)
      if (current === generation.current) {
        setError(true)
        setRows((previous) => previous.map((row) => ({ ...row, status: 'error' })))
      }
    } finally {
      if (current === generation.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => {
      void refresh()
    }, 60_000)
    return () => {
      clearInterval(interval)
      generation.current++
    }
  }, [refresh, sessionId, kind])

  return { rows, refreshing, error, refresh }
}
