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
      { type: 'turn.start', sessionId: 'sess_1', text: 'fix it', attachments: [] },
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
      { type: 'turn.start', sessionId: 'sess_1', text: 'again', attachments: [] },
      { turnId: 'turn_2', messageId: 'msg_2' },
    )
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('already active')
  })

  it('folds staged images into image parts ahead of the text', () => {
    const ref = { id: 'att_1', name: 'shot.png', mimeType: 'image/png', size: 8 }
    const result = decideCommand(
      modelWithSession(),
      { type: 'turn.start', sessionId: 'sess_1', text: 'look', attachments: [ref] },
      ids,
    )
    expect(result.accepted).toBe(true)
    const added = result.events.find((e) => e.type === 'user.message.added')
    expect(added).toMatchObject({
      message: {
        parts: [
          { type: 'image', attachmentId: 'att_1', name: 'shot.png', mimeType: 'image/png', size: 8 },
          { type: 'text', text: 'look' },
        ],
      },
    })
  })

  it('omits the text part for image-only turns', () => {
    const ref = { id: 'att_1', name: 'shot.png', mimeType: 'image/png', size: 8 }
    const result = decideCommand(
      modelWithSession(),
      { type: 'turn.start', sessionId: 'sess_1', text: '', attachments: [ref] },
      ids,
    )
    expect(result.accepted).toBe(true)
    const added = result.events.find((e) => e.type === 'user.message.added')
    expect(added).toMatchObject({ message: { parts: [{ type: 'image', attachmentId: 'att_1' }] } })
    expect(result.events.some((e) => e.type === 'session.updated')).toBe(false)
  })

  it('queues messages behind an active turn', () => {
    const idle = modelWithSession()
    const running = previewDispatch(idle, {
      accepted: true,
      events: [{ type: 'turn.started', turnId: 'turn_1' }],
    })
    const result = decideCommand(
      running,
      { type: 'message.enqueue', sessionId: 'sess_1', text: 'one more thing', attachments: [] },
      ids,
    )
    expect(result.accepted).toBe(true)
    expect(result.startsTurn).toBeUndefined()
    expect(result.events.map((e) => e.type)).toEqual(['message.enqueued'])
    expect(previewDispatch(running, result).lastSeq).toBeGreaterThan(running.lastSeq)
  })

  it('starts a turn when an enqueue arrives with no active turn', () => {
    const result = decideCommand(
      modelWithSession(),
      { type: 'message.enqueue', sessionId: 'sess_1', text: 'hi', attachments: [] },
      ids,
    )
    expect(result.accepted).toBe(true)
    expect(result.startsTurn).toBe(true)
    expect(result.events.map((e) => e.type)).toEqual([
      'turn.started',
      'user.message.added',
      'session.status.changed',
    ])
  })

  it('steers a queued message into the active turn', () => {
    const running = previewDispatch(modelWithSession(), {
      accepted: true,
      events: [
        { type: 'turn.started', turnId: 'turn_1' },
        { type: 'message.enqueued', text: 'focus on the parser', attachments: [] },
      ],
    })
    const result = decideCommand(
      running,
      { type: 'message.steer', sessionId: 'sess_1', text: 'focus on the parser', attachments: [] },
      ids,
    )
    // Delivery is only knowable at execution time, so the decider gates
    // preconditions and leaves the events to the engine.
    expect(result.accepted).toBe(true)
    expect(result.events).toEqual([])
  })

  it('refuses to steer a message that is not queued, has images, or has no turn', () => {
    const idle = modelWithSession()
    expect(
      decideCommand(
        idle,
        { type: 'message.steer', sessionId: 'sess_1', text: 'hi', attachments: [] },
        ids,
      ).accepted,
    ).toBe(false)

    const running = previewDispatch(idle, {
      accepted: true,
      events: [{ type: 'turn.started', turnId: 'turn_1' }],
    })
    expect(
      decideCommand(
        running,
        { type: 'message.steer', sessionId: 'sess_1', text: 'never queued', attachments: [] },
        ids,
      ).accepted,
    ).toBe(false)

    const ref = { id: 'att_9', name: 'b.png', mimeType: 'image/png', size: 4 }
    const imaged = previewDispatch(running, {
      accepted: true,
      events: [{ type: 'message.enqueued', text: 'see this', attachments: [ref] }],
    })
    expect(
      decideCommand(
        imaged,
        { type: 'message.steer', sessionId: 'sess_1', text: 'see this', attachments: [ref] },
        ids,
      ).accepted,
    ).toBe(false)
  })

  it('drops a queued message, echoing its stored origin', () => {
    const origin = { kind: 'session' as const, sessionId: 'child_1' }
    const running = previewDispatch(modelWithSession(), {
      accepted: true,
      events: [
        { type: 'turn.started', turnId: 'turn_1' },
        { type: 'message.enqueued', text: 'from the child', attachments: [], origin },
      ],
    })
    // The command carries no origin (the UI has none); the decider must echo
    // the stored one or the projection's origin-aware match never lands.
    const result = decideCommand(
      running,
      { type: 'message.dequeue', sessionId: 'sess_1', text: 'from the child', attachments: [] },
      ids,
    )
    expect(result.accepted).toBe(true)
    expect(result.events).toEqual([
      { type: 'message.dequeued', text: 'from the child', attachments: [], origin },
    ])
    expect(previewDispatch(running, result).queuedMessages).toEqual([])
  })

  it('refuses to drop a message that is not queued', () => {
    const running = previewDispatch(modelWithSession(), {
      accepted: true,
      events: [{ type: 'turn.started', turnId: 'turn_1' }],
    })
    expect(
      decideCommand(
        running,
        { type: 'message.dequeue', sessionId: 'sess_1', text: 'ghost', attachments: [] },
        ids,
      ).accepted,
    ).toBe(false)
  })

  it('carries staged images on queued messages', () => {
    const running = previewDispatch(modelWithSession(), {
      accepted: true,
      events: [{ type: 'turn.started', turnId: 'turn_1' }],
    })
    const ref = { id: 'att_9', name: 'b.png', mimeType: 'image/png', size: 4 }
    const result = decideCommand(
      running,
      { type: 'message.enqueue', sessionId: 'sess_1', text: '', attachments: [ref] },
      ids,
    )
    expect(result.accepted).toBe(true)
    expect(previewDispatch(running, result).queuedMessages).toEqual([
      { text: '', attachments: [ref] },
    ])
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

  it('accepts input.respond for a live agent question and answers once', () => {
    let model = modelWithSession()
    model = previewDispatch(model, {
      accepted: true,
      events: [
        { type: 'turn.started', turnId: 'turn_1' },
        { type: 'input.requested', inputId: 'q1', prompt: 'Pick one', choicesJson: '["a","b"]' },
      ],
    })
    const command: Command = {
      type: 'input.respond',
      sessionId: 'sess_1',
      inputId: 'q1',
      value: 'a',
    }
    const result = decideCommand(model, command, ids)
    expect(result.accepted).toBe(true)
    expect(result.events[0]?.type).toBe('input.responded')
    const answered = previewDispatch(model, result)
    expect(answered.pendingInputs).toHaveLength(0)
    expect(decideCommand(answered, command, ids).accepted).toBe(false)
  })

  it('rejects input.respond without a matching pending question', () => {
    let model = modelWithSession()
    model = previewDispatch(model, {
      accepted: true,
      events: [{ type: 'turn.started', turnId: 'turn_1' }],
    })
    const result = decideCommand(
      model,
      { type: 'input.respond', sessionId: 'sess_1', inputId: 'q_missing', value: 'x' },
      ids,
    )
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('unknown or already-answered')
  })

  it('accepts checkpoint.revert when a checkpoint exists for the turn', () => {
    let model = modelWithSession()
    model = previewDispatch(model, {
      accepted: true,
      events: [{ type: 'checkpoint.captured', turnId: 't1', gitRef: 'refs/ari/s/t1' }],
    })
    const result = decideCommand(
      model,
      { type: 'checkpoint.revert', sessionId: 'sess_1', turnId: 't1' },
      ids,
    )
    expect(result.accepted).toBe(true)
    expect(result.events[0]?.type).toBe('checkpoint.reverted')
    const reverted = previewDispatch(model, result)
    expect(reverted.checkpoints).toHaveLength(0)
  })

  it('rejects checkpoint.revert without a captured checkpoint', () => {
    const result = decideCommand(
      modelWithSession(),
      { type: 'checkpoint.revert', sessionId: 'sess_1', turnId: 't1' },
      ids,
    )
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('no checkpoint')
  })

  it('pins, archives, and unpins through session.update patches', () => {
    const pin = decideCommand(
      modelWithSession(),
      { type: 'session.update', sessionId: 'sess_1', pinned: true },
      ids,
    )
    expect(pin.accepted).toBe(true)
    expect(pin.events[0]).toEqual({ type: 'session.updated', pinned: true })
    let model = previewDispatch(modelWithSession(), pin)
    expect(model.session?.pinned).toBe(true)

    const archive = decideCommand(
      model,
      { type: 'session.update', sessionId: 'sess_1', archived: true },
      ids,
    )
    expect(archive.events[0]).toEqual({ type: 'session.updated', archived: true })
    model = previewDispatch(model, archive)
    expect(model.session?.archived).toBe(true)
    expect(model.session?.pinned).toBe(true)

    // Unpin + unarchive round-trip back to the defaults.
    const clear = decideCommand(
      model,
      { type: 'session.update', sessionId: 'sess_1', archived: false, pinned: false },
      ids,
    )
    expect(clear.accepted).toBe(true)
    model = previewDispatch(model, clear)
    expect(model.session?.archived).toBe(false)
    expect(model.session?.pinned).toBe(false)
  })
})
