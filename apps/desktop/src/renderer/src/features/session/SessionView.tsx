import { useCallback, useEffect, useRef, useState } from 'react'
import type { JournalEvent } from '@ari/contracts/events'
import type { Message } from '@ari/contracts/message'
import type { Session } from '@ari/contracts/session'
import type { SessionEventFrame } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { TranscriptView } from '../transcript'
import { Composer } from '../composer/Composer'

/**
 * Binds one session's journal to the transcript and composer: replays on
 * mount, applies live events, dispatches turns through the engine.
 */
export function SessionView({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [running, setRunning] = useState(false)
  const [queued, setQueued] = useState<string[]>([])
  const queuedRef = useRef<string[]>([])
  queuedRef.current = queued

  useEffect(() => {
    let cancelled = false
    setMessages([])
    setRunning(false)

    void rpc.invoke('session.load', { sessionId }).then((model) => {
      if (cancelled || !model) return
      const m = model as { session: Session; messages: Message[]; activeTurnId: string | null }
      setMessages(m.messages)
      setRunning(m.activeTurnId !== null)
    })

    const unsubscribe = rpc.subscribe('session.events', { sessionId }, (payload) => {
      const frame = payload as SessionEventFrame
      if (frame.sessionId !== sessionId) return
      applyEvent(frame.event as JournalEvent)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [sessionId])

  const applyEvent = useCallback((event: JournalEvent) => {
    switch (event.type) {
      case 'user.message.added':
        setMessages((prev) => [...prev, event.message])
        break
      case 'assistant.parts.appended':
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === event.messageId)
          if (existing) {
            return prev.map((m) =>
              m.id === event.messageId ? { ...m, parts: [...m.parts, ...event.parts] } : m,
            )
          }
          return [
            ...prev,
            {
              id: event.messageId,
              sessionId: event.sessionId,
              turnId: null,
              role: 'assistant',
              parts: [...event.parts],
              createdAt: event.at,
            },
          ]
        })
        break
      case 'turn.started':
        setRunning(true)
        break
      case 'turn.settled':
        setRunning(false)
        // Release the head of the queue as the next turn.
        setQueued((prev) => {
          const [next, ...rest] = prev
          if (next) {
            void rpc
              .invoke('command.dispatch', {
                command: { type: 'turn.start', sessionId: event.sessionId, text: next },
              })
              .catch(() => undefined)
          }
          return rest
        })
        break
      case 'session.status.changed':
        break
      default:
        break
    }
  }, [])

  const handleSend = useCallback(
    (text: string) => {
      if (running) {
        setQueued((prev) => [...prev, text])
        void rpc
          .invoke('command.dispatch', { command: { type: 'message.enqueue', sessionId, text } })
          .catch(() => undefined)
        return
      }
      void rpc
        .invoke('command.dispatch', { command: { type: 'turn.start', sessionId, text } })
        .catch(() => undefined)
    },
    [sessionId, running],
  )

  const handleStop = useCallback(() => {
    void rpc
      .invoke('command.dispatch', { command: { type: 'turn.interrupt', sessionId } })
      .catch(() => undefined)
  }, [sessionId])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <TranscriptView sessionId={sessionId} messages={messages} />
      </div>
      <Composer onSend={handleSend} onStop={handleStop} running={running} queued={queued} />
    </div>
  )
}
