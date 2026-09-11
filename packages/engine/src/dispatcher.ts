import type { Command } from '@ari/contracts/commands'
import type { JournalEvent } from '@ari/contracts/events'
import type { MessagePart, MessageOrigin } from '@ari/contracts/message'
import type { AttachmentRef, QueuedMessage } from '@ari/contracts/attachments'
import {
  applyEvent,
  initialReadModel,
  type DistributiveOmit,
  type SessionReadModel,
} from './projection'
import { deriveSliceTitle } from './title'

export type UnstampedJournalEvent = DistributiveOmit<JournalEvent, 'seq' | 'at' | 'sessionId'>

export interface DispatchDecision {
  accepted: boolean
  reason?: string
  /**
   * True when the decided events open a new turn. `message.enqueue` arriving
   * with no active turn is decided as one, so turn-lifecycle callers key off
   * this rather than the command type.
   */
  startsTurn?: boolean
  /** Events to persist, in order, when accepted. */
  events: UnstampedJournalEvent[]
}

export interface DispatchIds {
  turnId: string
  messageId: string
}

/**
 * Pure command decider (T3-style): given the current read model and a
 * command, decides which journal events should be appended — or why the
 * command is rejected. No I/O; fully unit-testable.
 */
export function decideCommand(
  model: SessionReadModel,
  command: Command,
  ids: DispatchIds,
  origin?: MessageOrigin,
): DispatchDecision {
  if (!model.session) {
    return reject('unknown session')
  }

  switch (command.type) {
    case 'session.create':
      // Sessions are created through SessionStore directly.
      return reject('session.create is handled by the store')

    case 'turn.start': {
      if (command.sessionId !== model.session.id) return reject('session id mismatch')
      if (model.activeTurnId) return reject('a turn is already active')
      return startTurn(model, command.text, command.attachments ?? [], ids, origin)
    }

    case 'message.enqueue': {
      if (command.sessionId !== model.session.id) return reject('session id mismatch')
      // A send that races a settle must never be lost. With no active turn the
      // message simply *is* the next turn, so decide it as one instead of
      // rejecting a command the user has no way to retry.
      if (!model.activeTurnId) {
        return startTurn(model, command.text, command.attachments ?? [], ids, origin)
      }
      return accept([
        {
          type: 'message.enqueued',
          text: command.text,
          attachments: command.attachments ?? [],
          ...(origin ? { origin } : {}),
        },
      ])
    }

    case 'message.steer': {
      if (command.sessionId !== model.session.id) return reject('session id mismatch')
      if (!model.activeTurnId) return reject('no active turn to steer into')
      // Steering rides the provider's text control channel; there is no image
      // channel on that path, so an imaged message can only run as a turn.
      if ((command.attachments ?? []).length > 0) {
        return reject('a message with images cannot steer mid-turn')
      }
      if (findQueued(model, command.text, command.attachments ?? []) === undefined) {
        return reject('message is no longer queued')
      }
      // Whether the adapter takes the text is only known at execution time, so
      // the engine appends the dequeue — the decider gates preconditions only.
      return accept([])
    }

    case 'message.dequeue': {
      if (command.sessionId !== model.session.id) return reject('session id mismatch')
      const queued = findQueued(model, command.text, command.attachments ?? [])
      if (queued === undefined) return reject('message is no longer queued')
      // Echo the stored message rather than the command so the projection's
      // origin-aware match always lands (commands from the UI carry none).
      return accept([
        {
          type: 'message.dequeued',
          text: queued.text,
          attachments: queued.attachments,
          ...(queued.origin ? { origin: queued.origin } : {}),
        },
      ])
    }

    case 'turn.interrupt': {
      if (command.sessionId !== model.session.id) return reject('session id mismatch')
      if (!model.activeTurnId) return reject('no active turn to interrupt')
      return accept([
        {
          type: 'turn.settled',
          turnId: model.activeTurnId,
          stopReason: 'interrupted',
          errorMessage: null,
        },
        {
          type: 'session.status.changed',
          from: model.session.status,
          to: 'idle',
          reason: 'interrupted',
        },
      ])
    }

    case 'approval.respond': {
      if (command.sessionId !== model.session.id) return reject('session id mismatch')
      const pending = model.pendingApprovals.find((a) => a.approvalId === command.approvalId)
      if (!pending) return reject('unknown or already-answered approval')
      return accept([
        { type: 'approval.responded', approvalId: command.approvalId, decision: command.decision },
      ])
    }

    case 'input.respond': {
      if (command.sessionId !== model.session.id) return reject('session id mismatch')
      if (!model.activeTurnId) return reject('no active turn awaiting input')
      const pending = model.pendingInputs.find((i) => i.inputId === command.inputId)
      if (!pending) return reject('unknown or already-answered input')
      return accept([{ type: 'input.responded', inputId: command.inputId, value: command.value }])
    }

    case 'checkpoint.revert': {
      if (command.sessionId !== model.session.id) return reject('session id mismatch')
      const checkpoint = model.checkpoints.find((c) => c.turnId === command.turnId)
      if (!checkpoint) return reject('no checkpoint captured for that turn')
      return accept([
        { type: 'checkpoint.reverted', turnId: command.turnId, gitRef: checkpoint.gitRef },
      ])
    }

    case 'session.update': {
      if (command.sessionId !== model.session.id) return reject('session id mismatch')
      const patch: UnstampedJournalEvent = {
        type: 'session.updated',
        ...(command.driverKind !== undefined ? { driverKind: command.driverKind } : {}),
        ...(command.modelId !== undefined ? { modelId: command.modelId } : {}),
        ...(command.permissionMode !== undefined ? { permissionMode: command.permissionMode } : {}),
        ...(command.effort !== undefined ? { effort: command.effort } : {}),
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.archived !== undefined ? { archived: command.archived } : {}),
        ...(command.pinned !== undefined ? { pinned: command.pinned } : {}),
      }
      return accept([patch])
    }

    case 'session.destroy':
      // Destruction bypasses the decider — the rpc layer calls the store
      // directly (journals are removed wholesale; no event survives).
      return reject('session.destroy is handled by the store')
  }
}

/**
 * The one way a turn begins, shared by `turn.start` and by a `message.enqueue`
 * that found no active turn. Direct dispatches (tests, engine internals)
 * bypass zod defaults, so `attachments` is always passed resolved.
 */
function startTurn(
  model: SessionReadModel,
  text: string,
  attachments: AttachmentRef[],
  ids: DispatchIds,
  origin?: MessageOrigin,
): DispatchDecision {
  const session = model.session
  if (!session) return reject('unknown session')
  const parts: MessagePart[] = attachments.map((a) => ({
    type: 'image',
    attachmentId: a.id,
    name: a.name,
    mimeType: a.mimeType,
    size: a.size,
  }))
  if (text.length > 0) parts.push({ type: 'text', text })
  const events: UnstampedJournalEvent[] = [
    { type: 'turn.started', turnId: ids.turnId },
    {
      type: 'user.message.added',
      message: {
        id: ids.messageId,
        sessionId: session.id,
        turnId: ids.turnId,
        role: 'user',
        ...(origin ? { origin } : {}),
        parts,
        createdAt: Date.now(),
      },
    },
    {
      type: 'session.status.changed',
      from: session.status,
      to: 'running',
      reason: null,
    },
  ]
  // Auto-title: first prompt names an untouched session (T3 behavior).
  if (session.title === 'New session' && text.trim().length > 0) {
    events.push({
      type: 'session.updated',
      title: deriveSliceTitle(text),
    })
  }
  return { accepted: true, startsTurn: true, events }
}

/** Matches a queued message by text and image set — the projection's own rule. */
function findQueued(
  model: SessionReadModel,
  text: string,
  attachments: readonly AttachmentRef[],
): QueuedMessage | undefined {
  const idsOf = (ids: readonly AttachmentRef[]): string => ids.map((a) => a.id).join(',')
  const want = idsOf(attachments)
  return model.queuedMessages.find((m) => m.text === text && idsOf(m.attachments) === want)
}

function accept(events: DispatchDecision['events'], startsTurn = false): DispatchDecision {
  return startsTurn ? { accepted: true, startsTurn, events } : { accepted: true, events }
}

function reject(reason: string): DispatchDecision {
  return { accepted: false, reason, events: [] }
}

/** Derives a sidebar title from the first user prompt (max 48 chars). */
export { deriveSliceTitle as deriveTitle } from './title'

/**
 * Convenience: folds decided events onto a copy of the model so callers can
 * validate the post-state without touching the store.
 */
export function previewDispatch(
  model: SessionReadModel,
  decision: DispatchDecision,
): SessionReadModel {
  let next = model
  for (const event of decision.events) {
    next = applyEvent(next, {
      ...event,
      seq: next.lastSeq + 1,
      at: Date.now(),
      sessionId: model.session?.id ?? '',
    })
  }
  return next
}

export { initialReadModel }
