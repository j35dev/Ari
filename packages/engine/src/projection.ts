import type { JournalEvent } from '@ari/contracts/events'
import type { Message } from '@ari/contracts/message'
import type { Session, SessionStatus } from '@ari/contracts/session'

/** Omit that distributes over unions — required for discriminated events. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A journal event before the engine stamps seq/at/sessionId onto it. */
export type UnstampedEvent = DistributiveOmit<JournalEvent, 'seq' | 'at' | 'sessionId'>

/**
 * Read model for one session, derived purely by folding journal events.
 * The UI observes this shape; it never reads journals directly.
 */
export interface SessionReadModel {
  session: Session | null
  messages: Message[]
  /** Streaming assistant message currently accepting parts, if any. */
  streamingMessageId: string | null
  activeTurnId: string | null
  status: SessionStatus | 'unknown'
  pendingApprovals: { approvalId: string; toolName: string; summaryJson: string }[]
  checkpoints: { turnId: string; gitRef: string }[]
  lastSeq: number
}

export function initialReadModel(): SessionReadModel {
  return {
    session: null,
    messages: [],
    streamingMessageId: null,
    activeTurnId: null,
    status: 'unknown',
    pendingApprovals: [],
    checkpoints: [],
    lastSeq: -1,
  }
}

/**
 * Pure left-fold: state = apply(apply(initial, e1), e2)... Deterministic,
 * side-effect free, and unit-testable without any I/O.
 */
export function applyEvent(state: SessionReadModel, event: JournalEvent): SessionReadModel {
  const next: SessionReadModel = {
    ...state,
    lastSeq: Math.max(state.lastSeq, event.seq),
  }

  switch (event.type) {
    case 'session.created':
      next.session = event.session
      next.status = event.session.status
      break

    case 'session.status.changed':
      next.status = event.to
      if (next.session) next.session = { ...next.session, status: event.to }
      break

    case 'user.message.added':
      next.messages = [...next.messages, event.message]
      next.streamingMessageId = null
      break

    case 'assistant.parts.appended': {
      const existing = next.messages.find((m) => m.id === event.messageId)
      if (!existing) {
        const message: Message = {
          id: event.messageId,
          sessionId: event.sessionId,
          turnId: next.activeTurnId,
          role: 'assistant',
          parts: [...event.parts],
          createdAt: event.at,
        }
        next.messages = [...next.messages, message]
      } else {
        next.messages = next.messages.map((m) =>
          m.id === event.messageId ? { ...m, parts: [...m.parts, ...event.parts] } : m,
        )
      }
      next.streamingMessageId = event.messageId
      break
    }

    case 'turn.started':
      next.activeTurnId = event.turnId
      next.streamingMessageId = null
      break

    case 'turn.settled':
      next.activeTurnId = null
      next.streamingMessageId = null
      break

    case 'approval.requested':
      next.pendingApprovals = [
        ...next.pendingApprovals,
        { approvalId: event.approvalId, toolName: event.toolName, summaryJson: event.summaryJson },
      ]
      break

    case 'approval.responded':
      next.pendingApprovals = next.pendingApprovals.filter(
        (a) => a.approvalId !== event.approvalId,
      )
      break

    case 'checkpoint.captured':
      next.checkpoints = [
        ...next.checkpoints.filter((c) => c.turnId !== event.turnId),
        { turnId: event.turnId, gitRef: event.gitRef },
      ]
      break
  }

  return next
}

/** Folds a full event list into a read model (boot replay path). */
export function projectEvents(events: JournalEvent[]): SessionReadModel {
  return events.reduce(applyEvent, initialReadModel())
}
