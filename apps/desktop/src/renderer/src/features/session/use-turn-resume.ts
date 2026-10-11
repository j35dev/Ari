import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { formatResumeTime, resumeTime } from './resume-time'
import { classifyTurnError, THROTTLED_TITLE } from './turnError'
import type { TurnResume } from './TurnErrorBanner'

const log = createLogger('session:resume')

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
  const throttled = turnError !== null && classifyTurnError(turnError).title === THROTTLED_TITLE
  const [resetAt, setResetAt] = useState<number | null>(null)
  const [scheduledAt, setScheduledAt] = useState<number | null>(null)

  useEffect(() => {
    setResetAt(null)
    setScheduledAt(null)
    if (!throttled) return
    let cancelled = false
    void rpc
      .invoke('providers.allowance', { kind: driverKind })
      .then((allowance) => {
        if (!cancelled) setResetAt(resumeTime(allowance, Date.now()))
      })
      .catch((error: unknown) => log.warn('allowance lookup failed', { error: String(error) }))
    void rpc
      .invoke('session.resume.get', { sessionId })
      .then((result) => {
        if (!cancelled) setScheduledAt(result.at)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [sessionId, driverKind, throttled])

  const onSchedule = useCallback(() => {
    if (resetAt === null) return
    void rpc
      .invoke('session.resume.schedule', { sessionId, at: resetAt })
      .then((result) => setScheduledAt(result.at))
      .catch((error: unknown) => log.warn('resume was not scheduled', { error: String(error) }))
  }, [sessionId, resetAt])

  const onCancel = useCallback(() => {
    void rpc
      .invoke('session.resume.cancel', { sessionId })
      .then(() => setScheduledAt(null))
      .catch((error: unknown) => log.warn('resume was not cancelled', { error: String(error) }))
  }, [sessionId])

  return useMemo(
    () =>
      throttled
        ? {
            resetAt,
            scheduledAt,
            format: (at: number) => formatResumeTime(at, Date.now()),
            onSchedule,
            onCancel,
          }
        : undefined,
    [throttled, resetAt, scheduledAt, onSchedule, onCancel],
  )
}
