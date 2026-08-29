import { useEffect, useRef, useState } from 'react'
import type { SessionEventFrame } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import {
  lingerMsFor,
  reduceSessionActivity,
  type ActivityEvent,
  type SessionActivity,
} from './session-activity'

/**
 * Live overlay of which sidebar sessions are working, paused on the user,
 * or just settled. Hydrates from the global `session.events` feed (no
 * journal replay — a reload never resurrects a dead turn).
 */
export function useSessionActivity(): {
  activityOf: (sessionId: string) => SessionActivity | undefined
} {
  const [byId, setById] = useState<ReadonlyMap<string, SessionActivity>>(() => new Map())
  const byIdRef = useRef(byId)
  byIdRef.current = byId
  const lingerRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const clearLinger = (sessionId: string): void => {
      const timer = lingerRef.current.get(sessionId)
      if (timer === undefined) return
      clearTimeout(timer)
      lingerRef.current.delete(sessionId)
    }

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

      clearLinger(sessionId)
      const linger = nextActivity === undefined ? null : lingerMsFor(nextActivity.phase)
      if (linger === null) return
      lingerRef.current.set(
        sessionId,
        setTimeout(() => {
          lingerRef.current.delete(sessionId)
          const current = byIdRef.current.get(sessionId)
          if (current?.phase !== 'done' && current?.phase !== 'error') return
          const cleared = new Map(byIdRef.current)
          cleared.delete(sessionId)
          byIdRef.current = cleared
          setById(cleared)
        }, linger),
      )
    })

    return () => {
      unsubscribe()
      for (const timer of lingerRef.current.values()) clearTimeout(timer)
      lingerRef.current.clear()
    }
  }, [])

  return { activityOf: (sessionId) => byId.get(sessionId) }
}
