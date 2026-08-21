import { describe, expect, it } from 'vitest'
import type { Command } from '@ari/contracts/commands'
import type { Session } from '@ari/contracts/session'
import { decideCommand, previewDispatch, type DispatchIds } from './dispatcher'
import { applyEvent, initialReadModel } from './projection'

const session: Session = {
  id: 'sess_1',
  projectId: 'proj_1',
  title: 'T',
  driverKind: 'claude',
  modelId: null,
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1000,
  updatedAt: 1000,
}

const ids: DispatchIds = { turnId: 'turn_1', messageId: 'msg_1' }

function modelWithSession() {
  return applyEvent(initialReadModel(), {
    type: 'session.created',
    seq: 0,
    at: 1000,
    sessionId: session.id,
    session,
  })
}

describe('decideCommand', () => {
  it('rejects commands for unknown sessions', () => {
    const result = decideCommand(initialReadModel(), { type: 'turn.interrupt', sessionId: 'sess_x' }, ids)
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('unknown session')
  })

  it('accepts turn.start when idle and emits started + message + running', () => {
    const result = decideCommand(
      modelWithSession(),
      { type: 'turn.start', sessionId: 'sess_1', text: 'fix it', attachmentPaths: [] },
      ids,
    )
    expect(result.accepted).toBe(true)
    expect(result.events.map((e) => e.type)).toEqual([
      'turn.started',
      'user.message.added',
      'session.status.changed',
    ])
    const preview = previewDispatch(modelWithSession(), result)
    expect(preview.status).toBe('running')
    expect(preview.activeTurnId).toBe('turn_1')
    expect(preview.messages).toHaveLength(1)
  })

  it('rejects concurrent turn.start while a turn is active', () => {
    let model = modelWithSession()
    model = previewDispatch(model, {
      accepted: true,
      events: [{ type: 'turn.started', turnId: 'turn_1' }],
    })
    const result = decideCommand(
      model,
      { type: 'turn.start', sessionId: 'sess_1', text: 'again', attachmentPaths: [] },
      { turnId: 'turn_2', messageId: 'msg_2' },
    )
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('already active')
  })

  it('queues messages only behind an active turn', () => {
    const idle = modelWithSession()
    expect(
      decideCommand(idle, { type: 'message.enqueue', sessionId: 'sess_1', text: 'hi' }, ids)
        .accepted,
    ).toBe(false)

    const running = previewDispatch(idle, {
      accepted: true,
      events: [{ type: 'turn.started', turnId: 'turn_1' }],
    })
    const result = decideCommand(
      running,
      { type: 'message.enqueue', sessionId: 'sess_1', text: 'one more thing' },
      ids,
    )
    expect(result.accepted).toBe(true)
    expect(previewDispatch(running, result).lastSeq).toBeGreaterThan(running.lastSeq)
  })

  it('interrupts the active turn and returns to idle', () => {
    let model = modelWithSession()
    model = previewDispatch(model, {
      accepted: true,
      events: [
        { type: 'turn.started', turnId: 'turn_1' },
        { type: 'session.status.changed', from: 'idle', to: 'running', reason: null },
      ],
    })
    const result = decideCommand(model, { type: 'turn.interrupt', sessionId: 'sess_1' }, ids)
    expect(result.accepted).toBe(true)
    const preview = previewDispatch(model, result)
    expect(preview.status).toBe('idle')
    expect(preview.activeTurnId).toBeNull()
  })

  it('answers pending approvals exactly once', () => {
    let model = modelWithSession()
    model = previewDispatch(model, {
      accepted: true,
      events: [
        {
          type: 'approval.requested',
          approvalId: 'a1',
          toolName: 'bash',
          summaryJson: '{}',
        },
      ],
    })
    const command: Command = {
      type: 'approval.respond',
      sessionId: 'sess_1',
      approvalId: 'a1',
      decision: 'allow',
    }
    expect(decideCommand(model, command, ids).accepted).toBe(true)
    const answered = previewDispatch(model, decideCommand(model, command, ids))
    expect(decideCommand(answered, command, ids).accepted).toBe(false)
  })

  it('explicitly rejects milestone-deferred commands', () => {
    const result = decideCommand(
      modelWithSession(),
      { type: 'checkpoint.revert', sessionId: 'sess_1', turnId: 't1' },
      ids,
    )
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('checkpointing')
  })
})
