import type { JournalEvent } from '@ari/contracts/events'
import type { Message } from '@ari/contracts/message'
import type { Session, SessionStatus } from '@ari/contracts/session'

/** Omit that distributes over unions — required for discriminated events. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A journal event before the engine stamps seq/at/sessionId onto it. */
export type UnstampedEvent = DistributiveOmit<JournalEvent, 'seq' | 'at' | 'sessionId'>

/** Cumulative token/cost accounting for one session. */
export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  /** Sum of provider-reported costs; null until an event carries a price. */
  costUsd: number | null
}

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
  /** Agent questions awaiting an `input.respond` answer. */
  pendingInputs: { inputId: string; prompt: string; choicesJson: string | null }[]
  /** User messages queued behind the active turn (survives reload via replay). */
  queuedMessages: string[]
  checkpoints: { turnId: string; gitRef: string }[]
  /** Provider-native session/thread id to resume, when one was observed. */
  providerSessionId: string | null
  usage: UsageTotals
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
    pendingInputs: [],
    queuedMessages: [],
    checkpoints: [],
    providerSessionId: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
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
      // Normalize the optional sidebar flags so every read model carries
      // concrete booleans even when folding pre-M18.2 journals.
      next.session = {
        ...event.session,
        archived: event.session.archived ?? false,
        pinned: event.session.pinned ?? false,
      }
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
      // A settled turn owns no live prompts: stopping (or failing) while a
      // question or approval is parked must not leave it answerable forever.
      // `input.respond` after settle rejects, and replay never resurrects it.
      next.pendingInputs = []
      next.pendingApprovals = []
      break

    case 'usage.recorded':
      next.usage = {
        inputTokens: state.usage.inputTokens + event.inputTokens,
        outputTokens: state.usage.outputTokens + event.outputTokens,
        costUsd:
          event.costUsd === null
            ? state.usage.costUsd
            : (state.usage.costUsd ?? 0) + event.costUsd,
      }
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

    case 'input.requested':
      next.pendingInputs = [
        ...next.pendingInputs,
        { inputId: event.inputId, prompt: event.prompt, choicesJson: event.choicesJson },
      ]
      break

    case 'input.responded':
      next.pendingInputs = next.pendingInputs.filter((i) => i.inputId !== event.inputId)
      break

    case 'message.enqueued':
      next.queuedMessages = [...next.queuedMessages, event.text]
      break

    case 'message.dequeued': {
      const idx = next.queuedMessages.indexOf(event.text)
      if (idx === -1) break
      next.queuedMessages = [
        ...next.queuedMessages.slice(0, idx),
        ...next.queuedMessages.slice(idx + 1),
      ]
      break
    }

    case 'checkpoint.captured':
      next.checkpoints = [
        ...next.checkpoints.filter((c) => c.turnId !== event.turnId),
        { turnId: event.turnId, gitRef: event.gitRef },
      ]
      break

    case 'checkpoint.reverted':
      next.checkpoints = next.checkpoints.filter((c) => c.turnId !== event.turnId)
      break

    case 'checkpoint.pruned':
      next.checkpoints = next.checkpoints.filter((c) => c.turnId !== event.turnId)
      break

    case 'session.ref.observed':
      next.providerSessionId = event.ref
      break

    case 'session.updated': {
      if (!next.session) break
      next.session = {
        ...next.session,
        ...(event.driverKind !== undefined ? { driverKind: event.driverKind } : {}),
        ...(event.modelId !== undefined ? { modelId: event.modelId } : {}),
        ...(event.permissionMode !== undefined ? { permissionMode: event.permissionMode } : {}),
        ...(event.effort !== undefined ? { effort: event.effort } : {}),
        ...(event.title !== undefined ? { title: event.title } : {}),
        ...(event.archived !== undefined ? { archived: event.archived } : {}),
        ...(event.pinned !== undefined ? { pinned: event.pinned } : {}),
      }
      break
    }
  }

  return next
}

/** Folds a full event list into a read model (boot replay path). */
export function projectEvents(events: JournalEvent[]): SessionReadModel {
  return events.reduce(applyEvent, initialReadModel())
}
