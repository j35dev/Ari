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
 * Settled badges stick: a session the user cannot see keeps its done/error mark
 * until they visit it (`acknowledge`) or start a new turn there. Every session
 * *on screen* counts as seen — with split panes that is up to six of them — so
 * each visible settle fades after `ACTIVE_SETTLE_LINGER_MS`, because its user
 * watched the lock-in play. The store is one small entry per live session, plus
 * a fade timer for each on-screen settle.
 */
export function useSessionActivity(visibleSessionIds: readonly string[]): {
  activityOf: (sessionId: string) => SessionActivity | undefined
  acknowledge: (sessionId: string) => void
  forget: (sessionId: string) => void
} {
  const [byId, setById] = useState<ReadonlyMap<string, SessionActivity>>(() => new Map())
  const byIdRef = useRef(byId)
  byIdRef.current = byId
  const visibleRef = useRef<ReadonlySet<string>>(new Set())
  visibleRef.current = new Set(visibleSessionIds)
  /** One fade timer per visible session, so two panes settling together both play out. */
  const fadeTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const clearFade = useCallback((sessionId: string): void => {
    const timer = fadeTimersRef.current.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    fadeTimersRef.current.delete(sessionId)
  }, [])

  const remove = useCallback(
    (sessionId: string): void => {
      clearFade(sessionId)
      if (!byIdRef.current.has(sessionId)) return
      const next = new Map(byIdRef.current)
      next.delete(sessionId)
      byIdRef.current = next
      setById(next)
    },
    [clearFade],
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
        if (visibleRef.current.has(sessionId)) {
          clearFade(sessionId)
          fadeTimersRef.current.set(
            sessionId,
            setTimeout(() => {
              fadeTimersRef.current.delete(sessionId)
              const current = byIdRef.current.get(sessionId)
              if (current?.phase !== 'done' && current?.phase !== 'error') return
              const cleared = new Map(byIdRef.current)
              cleared.delete(sessionId)
              byIdRef.current = cleared
              setById(cleared)
            }, ACTIVE_SETTLE_LINGER_MS),
          )
        }
      } else {
        // A new turn superseded the fading settle — stop the fade.
        clearFade(sessionId)
      }
    })

    return () => {
      unsubscribe()
      for (const timer of fadeTimersRef.current.values()) clearTimeout(timer)
      fadeTimersRef.current.clear()
    }
  }, [clearFade])

  return {
    activityOf: (sessionId) => byId.get(sessionId),
    acknowledge,
    forget,
  }
}
