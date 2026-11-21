import { useCallback, useEffect, useRef, useState } from 'react'
import { driverKindSchema } from '@ari/contracts/common'
import type { DriverKind } from '@ari/contracts/common'
import type {
  ProviderAllowance,
  ProvidersUpdateFrame,
  ResetCreditOutcome,
} from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { err, ok, type Result } from '@ari/shared/result'
import { rpc } from '../../lib/rpc'

const log = createLogger('ui:allowance')
/** Each probe launches the provider's CLI, so providers other than the session's are re-read rarely. */
const OTHER_PROVIDERS_MS = 5 * 60_000
const TICK_MS = 60_000
const RETURN_DELAY_MS = 3_000

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
  const tickOwed = useRef(false)
  // A read that began before a redemption finished may predate it; the count of
  // redemptions per provider lets that read be dropped instead of applied.
  const redeemed = useRef(new Map<string, number>())
  const focus = useRef(kind)
  focus.current = kind
  const latest = useRef(rows)
  latest.current = rows
  const lastPass = useRef(0)

  const refresh = useCallback(async function pass(onTimer = false): Promise<void> {
    // Slow provider CLIs can keep a pass going past the minute timer. Starting
    // another would drop everything the first is still waiting on, and under
    // sustained load no pass would ever land, so a request joins the one in flight.
    if (running.current === generation.current) {
      // A tick that found a pass running is owed: without it the next read is
      // two minutes after the last, and rows that answered early go stale.
      if (onTimer) tickOwed.current = true
      return
    }
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
        .filter(
          (row) => row.installed && row.enabled !== false && row.transport?.available !== false,
        )
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
      // Background passes re-read the session's provider and only stale others.
      const due = onTimer
        ? kinds.filter(
            (provider) =>
              provider === focus.current ||
              Date.now() - (latest.current.find((row) => row.kind === provider)?.checkedAt ?? 0) >=
                OTHER_PROVIDERS_MS,
          )
        : kinds
      lastPass.current = Date.now()
      setChecking(due)
      await Promise.all(
        due.map(async (provider) => {
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
        if (tickOwed.current) {
          tickOwed.current = false
          void pass(true)
        }
      }
    }
  }, [])

  useEffect(() => {
    void refresh(true)
    // Nothing is probed while Ari is minimized or hidden; a stale pill refreshes on return.
    const interval = setInterval(() => {
      if (!document.hidden) void refresh(true)
    }, TICK_MS)
    // On return, wait a moment: launching a CLI must not compete with the window repainting.
    let returning: ReturnType<typeof setTimeout> | undefined
    const visible = (): void => {
      clearTimeout(returning)
      if (document.hidden) return
      returning = setTimeout(() => {
        if (!document.hidden && Date.now() - lastPass.current >= TICK_MS) void refresh(true)
      }, RETURN_DELAY_MS)
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearTimeout(returning)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', visible)
      generation.current++
      tickOwed.current = false
    }
  }, [refresh, sessionId, kind])

  // After an account switch the bars on screen are another account's, not a
  // stale reading of this one: they go at once, and a read already in flight
  // for that provider is dropped the same way one that predates a redemption is.
  useEffect(
    () =>
      rpc.subscribe('providers.updates', {}, (payload) => {
        const frame = payload as ProvidersUpdateFrame
        if (frame.type !== 'accounts' || !frame.active) return
        const changed = frame.kind
        redeemed.current.set(changed, (redeemed.current.get(changed) ?? 0) + 1)
        setRows((previous) =>
          previous.map((row) =>
            row.kind === changed
              ? {
                  kind: changed,
                  status: 'unavailable',
                  windows: [],
                  updatedAt: null,
                  checkedAt: 0,
                  detail: '',
                }
              : row,
          ),
        )
        if (running.current === generation.current) tickOwed.current = true
        else void refresh()
      }),
    [refresh],
  )

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
