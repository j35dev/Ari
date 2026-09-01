import type { Command } from '@ari/contracts/commands'
import type { JournalEvent } from '@ari/contracts/events'
import { applyEvent, initialReadModel, type DistributiveOmit, type SessionReadModel } from './projection'
import { deriveSliceTitle } from './title'

export type UnstampedJournalEvent = DistributiveOmit<JournalEvent, 'seq' | 'at' | 'sessionId'>

export interface DispatchDecision {
  accepted: boolean
  reason?: string
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
      const events: UnstampedJournalEvent[] = [
        { type: 'turn.started', turnId: ids.turnId },
        {
          type: 'user.message.added',
          message: {
            id: ids.messageId,
            sessionId: model.session.id,
            turnId: ids.turnId,
            role: 'user',
            parts: [{ type: 'text', text: command.text }],
            createdAt: Date.now(),
          },
        },
        {
          type: 'session.status.changed',
          from: model.session.status,
          to: 'running',
          reason: null,
        },
      ]
      // Auto-title: first prompt names an untouched session (T3 behavior).
      if (model.session.title === 'New session' && command.text.trim().length > 0) {
        events.push({
          type: 'session.updated',
          title: deriveSliceTitle(command.text),
        })
      }
      return accept(events)
    }

    case 'message.enqueue': {
      if (command.sessionId !== model.session.id) return reject('session id mismatch')
      if (!model.activeTurnId) return reject('no active turn to queue behind; use turn.start')
      return accept([{ type: 'message.enqueued', text: command.text }])
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
      const pending = model.pendingApprovals.find(
        (a) => a.approvalId === command.approvalId,
      )
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

function accept(events: DispatchDecision['events']): DispatchDecision {
  return { accepted: true, events }
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
    next = applyEvent(next, { ...event, seq: next.lastSeq + 1, at: Date.now(), sessionId: model.session?.id ?? '' })
  }
  return next
}

export { initialReadModel }
