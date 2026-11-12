import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { useSessionClient } from './session-client'
import { formatResumeTime, resumeTime } from './resume-time'
import { classifyTurnError, THROTTLED_TITLE } from './turnError'
import type { TurnResume } from './TurnErrorBanner'

const log = createLogger('session:resume')

type ResumeState = Pick<
  TurnResume,
  'resetAt' | 'scheduledAt' | 'scheduleKnown' | 'pending' | 'error'
>

const INITIAL: ResumeState = {
  resetAt: null,
  scheduledAt: null,
  scheduleKnown: false,
  pending: 'lookup',
  error: null,
}

interface Snapshot extends ResumeState {
  sessionId: string
  driverKind: DriverKind
  throttled: boolean
  generation: number
  request: number
}

/**
 * The banner's "Resume at reset" controls for a turn a usage limit stopped.
 * Undefined for every other failure. The reset time comes from the provider's
 * own allowance windows, and the schedule itself lives in the main process so
 * it fires whether or not this session is on screen.
 */
export function useTurnResume(
  sessionId: string,
  turnError: string | null,
  driverKind: DriverKind,
): TurnResume | undefined {
  const rpc = useSessionClient()
  const throttled = turnError !== null && classifyTurnError(turnError).title === THROTTLED_TITLE
  const generation = useRef(0)
  const request = useRef(0)
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    ...INITIAL,
    sessionId,
    driverKind,
    throttled,
    generation: 0,
    request: 0,
  }))
  // A new session must not render the previous session's confirmed schedule,
  // even in the render before its effect resets the snapshot.
  const matches =
    snapshot.sessionId === sessionId &&
    snapshot.driverKind === driverKind &&
    snapshot.throttled === throttled
  const state = matches ? snapshot : INITIAL

  const update = useCallback(
    (owner: number, operation: number | null, patch: Partial<Snapshot>) => {
      setSnapshot((previous) =>
        generation.current === owner && (operation === null || request.current === operation)
          ? { ...previous, ...patch }
          : previous,
      )
    },
    [],
  )

  const checkSchedule = useCallback(
    (owner: number, operation: number) => {
      void rpc
        .invoke('session.resume.get', { sessionId })
        .then((result) =>
          update(owner, operation, {
            scheduledAt: result.at,
            scheduleKnown: true,
            pending: null,
            error: null,
          }),
        )
        .catch((error: unknown) => {
          log.warn('resume lookup failed', { error: String(error) })
          update(owner, operation, { pending: null, error: 'lookup' })
        })
    },
    [sessionId, update, rpc],
  )

  useEffect(() => {
    const owner = ++generation.current
    const operation = ++request.current
    setSnapshot({
      ...INITIAL,
      sessionId,
      driverKind,
      throttled,
      generation: owner,
      request: operation,
    })
    if (throttled) {
      void rpc
        .invoke('providers.allowance', { kind: driverKind })
        .then((allowance) => {
          update(owner, null, { resetAt: resumeTime(allowance, Date.now()) })
        })
        .catch((error: unknown) => log.warn('allowance lookup failed', { error: String(error) }))
      checkSchedule(owner, operation)
    }
    return () => {
      // Includes leaving and returning to the same session, clearing the error,
      // changing providers, unmounting, and StrictMode's effect replay.
      ++generation.current
    }
  }, [sessionId, driverKind, throttled, checkSchedule, update])

  const begin = useCallback(
    (pending: NonNullable<TurnResume['pending']>): number | null => {
      if (
        !throttled ||
        !matches ||
        snapshot.generation !== generation.current ||
        snapshot.request !== request.current ||
        snapshot.pending !== null
      )
        return null
      // Claim the request synchronously: two clicks before React commits the
      // pending state still issue only one RPC. Older callbacks also lose ownership.
      const operation = ++request.current
      update(snapshot.generation, operation, { request: operation, pending, error: null })
      return operation
    },
    [throttled, matches, snapshot, update],
  )

  const onCheck = useCallback(() => {
    if (state.scheduleKnown) return
    const operation = begin('lookup')
    if (operation !== null) checkSchedule(snapshot.generation, operation)
  }, [state.scheduleKnown, begin, checkSchedule, snapshot.generation])

  const onSchedule = useCallback(() => {
    if (!state.scheduleKnown || state.scheduledAt !== null || state.resetAt === null) return
    const operation = begin('schedule')
    if (operation === null) return
    void rpc
      // The schedule takes whole milliseconds; a provider's reset time need not be.
      .invoke('session.resume.schedule', { sessionId, at: Math.round(state.resetAt) })
      .then((result) =>
        update(snapshot.generation, operation, { scheduledAt: result.at, pending: null }),
      )
      .catch((error: unknown) => {
        log.warn('resume was not scheduled', { error: String(error) })
        update(snapshot.generation, operation, { pending: null, error: 'schedule' })
      })
  }, [state, begin, sessionId, snapshot.generation, update])

  const onCancel = useCallback(() => {
    if (!state.scheduleKnown || state.scheduledAt === null) return
    const operation = begin('cancel')
    if (operation === null) return
    void rpc
      .invoke('session.resume.cancel', { sessionId })
      .then(() => update(snapshot.generation, operation, { scheduledAt: null, pending: null }))
      .catch((error: unknown) => {
        log.warn('resume was not cancelled', { error: String(error) })
        // Keep the last confirmed schedule until cancellation is acknowledged.
        update(snapshot.generation, operation, { pending: null, error: 'cancel' })
      })
  }, [state, begin, sessionId, snapshot.generation, update])

  return useMemo(
    () =>
      throttled
        ? {
            resetAt: state.resetAt,
            scheduledAt: state.scheduledAt,
            scheduleKnown: state.scheduleKnown,
            pending: state.pending,
            error: state.error,
            format: (at: number) => formatResumeTime(at, Date.now()),
            onSchedule,
            onCancel,
            onCheck,
          }
        : undefined,
    [throttled, state, onSchedule, onCancel, onCheck],
  )
}
