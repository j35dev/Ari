import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionEventFrame } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import {
  ACTIVE_SETTLE_LINGER_MS,
  reduceSessionActivity,
  type ActivityEvent,
  type SessionActivity,
} from './session-activity'

/**
 * Live overlay of which sidebar sessions are working, paused on the user,
 * or just settled. Hydrates from the global `session.events` feed (no
 * journal replay — a reload never resurrects a dead turn).
 *
 * Settled badges stick: a background session keeps its done/error mark until
 * the user visits it (`acknowledge`) or starts a new turn there. Only the
 * session already on screen fades, after `ACTIVE_SETTLE_LINGER_MS`, because
 * its user has seen the lock-in play. The store is one small entry per live
 * session — no per-session timers, no persistence.
 */
export function useSessionActivity(activeSessionId: string | null): {
  activityOf: (sessionId: string) => SessionActivity | undefined
  acknowledge: (sessionId: string) => void
  forget: (sessionId: string) => void
} {
  const [byId, setById] = useState<ReadonlyMap<string, SessionActivity>>(() => new Map())
  const byIdRef = useRef(byId)
  byIdRef.current = byId
  const activeRef = useRef(activeSessionId)
  activeRef.current = activeSessionId
  const activeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearActiveTimer = useCallback((): void => {
    if (activeTimerRef.current !== null) {
      clearTimeout(activeTimerRef.current)
      activeTimerRef.current = null
    }
  }, [])

  const remove = useCallback(
    (sessionId: string): void => {
      // The single fade timer always belongs to the active session's settle.
      if (sessionId === activeRef.current) clearActiveTimer()
      if (!byIdRef.current.has(sessionId)) return
      const next = new Map(byIdRef.current)
      next.delete(sessionId)
      byIdRef.current = next
      setById(next)
    },
    [clearActiveTimer],
  )

  /** Visiting a session clears its settled badge; live phases are untouched. */
  const acknowledge = useCallback(
    (sessionId: string): void => {
      const current = byIdRef.current.get(sessionId)
      if (current?.phase !== 'done' && current?.phase !== 'error') return
      remove(sessionId)
    },
    [remove],
  )

  /** Dropping a session (delete) clears whatever mark it held. */
  const forget = useCallback(
    (sessionId: string): void => {
      remove(sessionId)
    },
    [remove],
  )

  useEffect(() => {
    const unsubscribe = rpc.subscribe('session.events', {}, (payload) => {
      const frame = payload as Partial<SessionEventFrame> | null
      if (frame?.replay === true || frame?.replayDone === true) return
      const sessionId = frame?.sessionId
      const event = frame?.event as ActivityEvent | undefined
      if (sessionId === undefined || event?.type === undefined) return

      const prev = byIdRef.current.get(sessionId)
      const nextActivity = reduceSessionActivity(prev, event, Date.now())
      if (nextActivity === prev) return

      const next = new Map(byIdRef.current)
      if (nextActivity === undefined) next.delete(sessionId)
      else next.set(sessionId, nextActivity)
      byIdRef.current = next
      setById(next)

      if (nextActivity?.phase === 'done' || nextActivity?.phase === 'error') {
        // Seen settle: play the lock-in, then fade. Unseen settle: stick
        // until the user visits the session or starts a new turn there.
        if (sessionId === activeRef.current) {
          clearActiveTimer()
          activeTimerRef.current = setTimeout(() => {
            activeTimerRef.current = null
            const current = byIdRef.current.get(sessionId)
            if (current?.phase !== 'done' && current?.phase !== 'error') return
            const cleared = new Map(byIdRef.current)
            cleared.delete(sessionId)
            byIdRef.current = cleared
            setById(cleared)
          }, ACTIVE_SETTLE_LINGER_MS)
        }
      } else if (activeTimerRef.current !== null && sessionId === activeRef.current) {
        // A new turn superseded the fading settle — stop the fade.
        clearActiveTimer()
      }
    })

    return () => {
      unsubscribe()
      if (activeTimerRef.current !== null) {
        clearTimeout(activeTimerRef.current)
        activeTimerRef.current = null
      }
    }
  }, [clearActiveTimer])

  return {
    activityOf: (sessionId) => byId.get(sessionId),
    acknowledge,
    forget,
  }
}
