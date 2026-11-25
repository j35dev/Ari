import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from './app-state'
import {
  applyEvents,
  fromSnapshot,
  prependPage,
  type Reconcile,
  type StreamedEvent,
  type Transcript,
  type TranscriptSnapshot,
} from './transcript'

/** Messages per read. Enough to fill a few screens; older ones load on request. */
export const PAGE_SIZE = 40
/** A follow-up read for something only the desktop can describe waits this long. */
const SOON_MS = 1200
/** A healthy stream is still reconciled now and then, cheaply. */
const RECONCILE_MS = 30_000
/** Folded events remembered for re-applying over a read that raced them. */
const RECENT_LIMIT = 2000

export interface TranscriptView {
  transcript: Transcript | null
  failure: string | null
  /** Reads the newest page again now. */
  reload: () => Promise<void>
  /** Loads the page before the first message held. */
  loadEarlier: () => Promise<void>
  loadingEarlier: boolean
}

/**
 * One session's conversation, kept current from its event stream.
 *
 * Reads are paged and only happen at open, after a gap or a reconnect, for
 * changes the phone cannot fold itself, and as a slow reconcile. Streamed
 * events are batched to one state update per animation frame, so a fast
 * stream costs one render per frame rather than one per token.
 */
export function useTranscript(sessionId: string): TranscriptView {
  const app = useApp()
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const current = useRef<Transcript | null>(null)
  const recent = useRef<StreamedEvent[]>([])
  const alive = useRef(true)
  const reading = useRef<Promise<void> | null>(null)
  const again = useRef(false)
  const soon = useRef<ReturnType<typeof setTimeout> | null>(null)
  const session = app.session
  const usable = session !== null && session.usable

  const commit = useCallback((next: Transcript): void => {
    current.current = next
    setTranscript(next)
  }, [])

  const read = useCallback((): Promise<void> => {
    if (session === null || !session.usable) return Promise.resolve()
    if (reading.current !== null) {
      // A read already in flight may predate what asked for this one.
      again.current = true
      return reading.current
    }
    const run = async (): Promise<void> => {
      try {
        do {
          again.current = false
          const snapshot = await session.query<TranscriptSnapshot | null>('session.get', {
            sessionId,
            limit: PAGE_SIZE,
          })
          if (!alive.current) return
          if (snapshot === null) {
            setFailure('This session is no longer available on your computer.')
            return
          }
          commit(fromSnapshot(snapshot, current.current, recent.current))
          setFailure(null)
        } while (again.current && alive.current)
      } catch (error) {
        if (alive.current)
          setFailure(error instanceof Error ? error.message : 'The desktop refused that.')
      } finally {
        reading.current = null
      }
    }
    reading.current = run()
    return reading.current
  }, [session, sessionId, commit])

  const follow = useCallback(
    (reconcile: Reconcile): void => {
      if (reconcile === 'now') {
        void read()
        return
      }
      if (reconcile === 'soon' && soon.current === null)
        soon.current = setTimeout(() => {
          soon.current = null
          void read()
        }, SOON_MS)
    },
    [read],
  )

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (soon.current !== null) clearTimeout(soon.current)
    }
  }, [])

  // The first read, and a reconcile whenever the connection comes back.
  useEffect(() => {
    if (usable) void read()
  }, [read, usable, app.connection])

  const loaded = transcript !== null
  useEffect(() => {
    if (session === null || !usable || !loaded || !session.supports('events.subscribe')) return
    let closed = false
    let queued: StreamedEvent[] = []
    let frame: (() => void) | null = null
    const flush = (): void => {
      frame = null
      if (closed || queued.length === 0) return
      const batch = queued
      queued = []
      const held = current.current
      if (held === null) return
      recent.current = [...recent.current, ...batch].slice(-RECENT_LIMIT)
      const result = applyEvents(held, batch)
      commit(result.transcript)
      follow(result.reconcile)
    }
    const schedule = (): void => {
      if (frame !== null) return
      // A hidden page gets no animation frames; it still has to keep up.
      if (document.visibilityState === 'visible' && typeof requestAnimationFrame === 'function') {
        const handle = requestAnimationFrame(flush)
        frame = () => cancelAnimationFrame(handle)
      } else {
        const handle = setTimeout(flush, 50)
        frame = () => clearTimeout(handle)
      }
    }
    const dispose = session.subscribe(sessionId, {
      fromSeq: current.current?.seq ?? 0,
      onFrame: (message) => {
        if (closed || typeof message !== 'object' || message === null) return
        const frameMessage = message as { type?: string; events?: StreamedEvent[] }
        if (frameMessage.type === 'events.frame' && Array.isArray(frameMessage.events)) {
          queued.push(...frameMessage.events)
          schedule()
        } else if (frameMessage.type === 'events.desync') void read()
      },
      onClose: () => {
        // MobileSession reports the loss to AppProvider, which owns reconnect.
        // The connected state opens one fresh stream after this effect cleans up.
      },
    })
    const reconcile = setInterval(() => {
      if (document.visibilityState === 'visible') void read()
    }, RECONCILE_MS)
    return () => {
      closed = true
      dispose()
      frame?.()
      clearInterval(reconcile)
    }
    // `wake` reopens the stream after the phone was away: iOS may have frozen
    // the old socket without closing it.
  }, [session, usable, app.connection, app.wake, sessionId, loaded, read, follow, commit])

  // After a wake the stream resumes from the cursor, but tasks and anything
  // the stream cannot carry are read again too.
  useEffect(() => {
    if (app.wake > 0 && usable) void read()
  }, [app.wake, usable, read])

  const loadEarlier = useCallback(async (): Promise<void> => {
    const held = current.current
    const first = held?.messages[0]
    if (session === null || held === null || first === undefined || held.earlier === 0) return
    setLoadingEarlier(true)
    try {
      const page = await session.query<TranscriptSnapshot | null>('session.get', {
        sessionId,
        limit: PAGE_SIZE,
        before: first.id,
      })
      if (!alive.current || page === null || current.current === null) return
      commit(prependPage(current.current, page))
    } catch (error) {
      if (alive.current)
        setFailure(error instanceof Error ? error.message : 'Could not load earlier messages.')
    } finally {
      if (alive.current) setLoadingEarlier(false)
    }
  }, [session, sessionId, commit])

  return { transcript, failure, reload: read, loadEarlier, loadingEarlier }
}
