import { useCallback, useEffect, useRef, useState } from 'react'
import { driverKindSchema } from '@ari/contracts/common'
import type { DriverKind } from '@ari/contracts/common'
import type { ProviderAllowance, ResetCreditOutcome } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { err, ok, type Result } from '@ari/shared/result'
import { rpc } from '../../lib/rpc'

const log = createLogger('ui:allowance')

/** Refresh account quotas independently, keeping failures local to each provider. */
export function useProviderAllowance(sessionId: string | null, kind: DriverKind) {
  const [rows, setRows] = useState<ProviderAllowance[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)
  /** When the last full pass over the providers finished; null before the first. */
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  /** Providers the running pass has not heard back from; they answer seconds apart. */
  const [checking, setChecking] = useState<string[]>([])
  const known = useRef<string[]>([])
  const generation = useRef(0)
  /** Generation of the pass in flight, if there is one. */
  const running = useRef<number | null>(null)
  // A read that began before a redemption finished may predate it; the count of
  // redemptions per provider lets that read be dropped instead of applied.
  const redeemed = useRef(new Map<string, number>())

  const refresh = useCallback(async () => {
    // Slow provider CLIs can keep a pass going past the minute timer. Starting
    // another would drop everything the first is still waiting on, and under
    // sustained load no pass would ever land, so a request joins the one in flight.
    if (running.current === generation.current) return
    const current = ++generation.current
    running.current = current
    setRefreshing(true)
    setError(false)
    // Rows already on screen are being re-read from the first moment, before
    // detection has confirmed the list.
    setChecking(known.current)
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
      known.current = kinds
      setChecking(kinds)
      await Promise.all(
        kinds.map(async (provider) => {
          const before = redeemed.current.get(provider)
          const fresh = () =>
            current === generation.current && redeemed.current.get(provider) === before
          try {
            const result = await rpc.invoke('providers.allowance', { kind: provider })
            if (fresh())
              setRows((previous) => previous.map((row) => (row.kind === provider ? result : row)))
          } catch (failure) {
            log.warn('Usage refresh failed', failure)
            if (fresh())
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
          } finally {
            if (current === generation.current)
              setChecking((pending) => pending.filter((entry) => entry !== provider))
          }
        }),
      )
      if (current === generation.current) setCheckedAt(Date.now())
    } catch (failure) {
      log.warn('Provider discovery failed', failure)
      if (current === generation.current) {
        setError(true)
        setRows((previous) => previous.map((row) => ({ ...row, status: 'error' })))
      }
    } finally {
      if (running.current === current) running.current = null
      if (current === generation.current) {
        setRefreshing(false)
        setChecking([])
      }
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

  const consumeReset = useCallback(
    async (kind: DriverKind, creditId?: string): Promise<Result<ResetCreditOutcome, string>> => {
      try {
        const result = await rpc.invoke('providers.consumeResetCredit', {
          kind,
          ...(creditId ? { creditId } : {}),
        })
        if (!result.ok) return err(result.error)
        redeemed.current.set(kind, (redeemed.current.get(kind) ?? 0) + 1)
        setRows((previous) => previous.map((row) => (row.kind === kind ? result.allowance : row)))
        return ok(result.outcome)
      } catch (failure) {
        log.warn('Reset redemption failed', failure)
        return err('Could not use the reset.')
      }
    },
    [],
  )

  return { rows, refreshing, checking, error, checkedAt, refresh, consumeReset }
}
