import { useCallback, useEffect, useState } from 'react'
import type { JournalEvent } from '@ari/contracts/events'
import type { Message } from '@ari/contracts/message'
import type { Session } from '@ari/contracts/session'
import type { SessionEventFrame } from '@ari/contracts/rpc'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import { rpc } from '../../lib/rpc'
import { TranscriptView } from '../transcript'
import { Composer } from '../composer/Composer'
import { ModelSelector } from '../composer/ModelSelector'
import { ApprovalCard } from '../approvals/ApprovalCard'

interface PendingApproval {
  approvalId: string
  toolName: string
  summaryJson: string
}

export interface SessionDefaults {
  driverKind: DriverKind
  modelId: string | null
  permissionMode: PermissionMode
}

/**
 * Binds one session's journal to the transcript and composer: replays on
 * mount, applies live events, dispatches turns through the engine.
 */
export function SessionView({
  sessionId,
  defaults,
  onDefaultsChange,
}: {
  sessionId: string
  defaults: SessionDefaults
  onDefaultsChange: (next: SessionDefaults) => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [running, setRunning] = useState(false)
  const [queued, setQueued] = useState<string[]>([])
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([])

  useEffect(() => {
    void rpc
      .invoke('files.index', { projectId: 'adhoc' })
      .then((r) => setFileSuggestions(r.paths))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    setMessages([])
    setRunning(false)
    setApprovals([])

    void rpc.invoke('session.load', { sessionId }).then((model) => {
      if (cancelled || !model) return
      const m = model as {
        session: Session
        messages: Message[]
        activeTurnId: string | null
      }
      setMessages(m.messages)
      setRunning(m.activeTurnId !== null)
      onDefaultsChange({
        driverKind: m.session.driverKind,
        modelId: m.session.modelId,
        permissionMode: m.session.permissionMode,
      })
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

  const applyEvent = useCallback(
    (event: JournalEvent) => {
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
        case 'approval.requested':
          setApprovals((prev) => [
            ...prev.filter((a) => a.approvalId !== event.approvalId),
            {
              approvalId: event.approvalId,
              toolName: event.toolName,
              summaryJson: event.summaryJson,
            },
          ])
          break
        case 'approval.responded':
          setApprovals((prev) => prev.filter((a) => a.approvalId !== event.approvalId))
          break
        default:
          break
      }
    },
    [],
  )

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

  const respondApproval = useCallback(
    (approvalId: string, decision: 'allow' | 'deny' | 'always-allow') => {
      void rpc
        .invoke('command.dispatch', {
          command: { type: 'approval.respond', sessionId, approvalId, decision },
        })
        .catch(() => undefined)
    },
    [sessionId],
  )

  const changeModel = useCallback(
    (next: { driverKind: DriverKind; modelId: string | null }) => {
      onDefaultsChange({ ...defaults, ...next })
      void rpc
        .invoke('command.dispatch', {
          command: {
            type: 'session.update',
            sessionId,
            driverKind: next.driverKind,
            modelId: next.modelId,
          },
        })
        .catch(() => undefined)
    },
    [sessionId, onDefaultsChange],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <TranscriptView sessionId={sessionId} messages={messages} />
      </div>
      {approvals.length > 0 ? (
        <div className="max-h-56 space-y-2 overflow-y-auto border-t border-border bg-surface-0 p-3">
          {approvals.map((a) => (
            <ApprovalCard
              key={a.approvalId}
              approvalId={a.approvalId}
              toolName={a.toolName}
              summaryJson={a.summaryJson}
              onRespond={(decision) =>
                respondApproval(
                  a.approvalId,
                  decision === 'always_allow' ? 'always-allow' : decision,
                )
              }
            />
          ))}
        </div>
      ) : null}
      <Composer
        onSend={handleSend}
        onStop={handleStop}
        running={running}
        queued={queued}
        suggestions={fileSuggestions}
        leading={
          <ModelSelector
            driverKind={defaults.driverKind}
            modelId={defaults.modelId}
            onChange={changeModel}
          />
        }
      />
    </div>
  )
}
