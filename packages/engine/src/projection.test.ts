import { describe, expect, it } from 'vitest'
import type { JournalEvent } from '@ari/contracts/events'
import { applyEvent, initialReadModel, projectEvents, type UnstampedEvent } from './projection'

const session = {
  id: 'sess_1',
  projectId: 'proj_1',
  title: 'Fix bug',
  driverKind: 'claude' as const,
  modelId: null,
  permissionMode: 'ask' as const,
  status: 'idle' as const,
  createdAt: 1000,
  updatedAt: 1000,
}

function ev(seq: number, partial: UnstampedEvent): JournalEvent {
  return { ...partial, seq, at: 1000 + seq, sessionId: 'sess_1' }
}

describe('session projection', () => {
  it('starts empty and folds session.created', () => {
    let state = initialReadModel()
    expect(state.status).toBe('unknown')
    state = applyEvent(state, ev(0, { type: 'session.created', session }))
    expect(state.session?.title).toBe('Fix bug')
    expect(state.status).toBe('idle')
    expect(state.lastSeq).toBe(0)
  })

  it('accumulates assistant parts into one streaming message', () => {
    let state = applyEvent(initialReadModel(), ev(0, { type: 'session.created', session }))
    state = applyEvent(state, ev(1, { type: 'turn.started', turnId: 'turn_1' }))
    state = applyEvent(
      state,
      ev(2, {
        type: 'assistant.parts.appended',
        messageId: 'msg_1',
        parts: [{ type: 'text', text: 'Hel' }],
      }),
    )
    state = applyEvent(
      state,
      ev(3, {
        type: 'assistant.parts.appended',
        messageId: 'msg_1',
        parts: [{ type: 'text', text: 'lo' }],
      }),
    )
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'Hel' })
    expect(state.messages[0]?.parts[1]).toEqual({ type: 'text', text: 'lo' })
    expect(state.streamingMessageId).toBe('msg_1')
    expect(state.activeTurnId).toBe('turn_1')
  })

  it('clears streaming + active turn on settle and tracks approvals lifecycle', () => {
    let state = applyEvent(initialReadModel(), ev(0, { type: 'session.created', session }))
    state = applyEvent(state, ev(1, { type: 'turn.started', turnId: 'turn_1' }))
    state = applyEvent(
      state,
      ev(2, {
        type: 'approval.requested',
        approvalId: 'a1',
        toolName: 'bash',
        summaryJson: '{}',
      }),
    )
    expect(state.pendingApprovals).toHaveLength(1)
    expect(state.status).toBe('idle') // status changes arrive as explicit events
    state = applyEvent(
      state,
      ev(3, { type: 'session.status.changed', from: 'running', to: 'waiting-approval', reason: null }),
    )
    expect(state.status).toBe('waiting-approval')
    state = applyEvent(state, ev(4, { type: 'approval.responded', approvalId: 'a1', decision: 'allow' }))
    expect(state.pendingApprovals).toHaveLength(0)
    state = applyEvent(state, ev(5, { type: 'turn.settled', turnId: 'turn_1', stopReason: 'completed', errorMessage: null }))
    expect(state.activeTurnId).toBeNull()
    expect(state.streamingMessageId).toBeNull()
  })

  it('keeps the latest checkpoint per turn and tracks lastSeq across out-of-order folds', () => {
    let state = applyEvent(initialReadModel(), ev(0, { type: 'session.created', session }))
    state = applyEvent(state, ev(9, { type: 'checkpoint.captured', turnId: 't1', gitRef: 'r1' }))
    state = applyEvent(state, ev(4, { type: 'checkpoint.captured', turnId: 't1', gitRef: 'r2' }))
    expect(state.checkpoints).toEqual([{ turnId: 't1', gitRef: 'r2' }])
    expect(state.lastSeq).toBe(9)
  })

  it('defaults archived/pinned to false and folds session.updated flag patches', () => {
    // Pre-M18.2 journal shape: no flags on session.created at all.
    let state = applyEvent(initialReadModel(), ev(0, { type: 'session.created', session }))
    expect(state.session?.archived).toBe(false)
    expect(state.session?.pinned).toBe(false)

    state = applyEvent(state, ev(1, { type: 'session.updated', pinned: true }))
    expect(state.session?.pinned).toBe(true)
    expect(state.session?.archived).toBe(false)

    state = applyEvent(state, ev(2, { type: 'session.updated', archived: true, pinned: false }))
    expect(state.session?.archived).toBe(true)
    expect(state.session?.pinned).toBe(false)

    // A full replay lands on the same folded state.
    const replayed = projectEvents([
      ev(0, { type: 'session.created', session }),
      ev(1, { type: 'session.updated', pinned: true }),
      ev(2, { type: 'session.updated', archived: true, pinned: false }),
    ])
    expect(replayed.session?.archived).toBe(true)
    expect(replayed.session?.pinned).toBe(false)
  })

  it('tracks agent questions from request to answered input', () => {
    let state = applyEvent(initialReadModel(), ev(0, { type: 'session.created', session }))
    state = applyEvent(state, ev(1, { type: 'turn.started', turnId: 'turn_1' }))
    state = applyEvent(
      state,
      ev(2, { type: 'input.requested', inputId: 'q1', prompt: 'Proceed?', choicesJson: null }),
    )
    expect(state.pendingInputs).toEqual([{ inputId: 'q1', prompt: 'Proceed?', choicesJson: null }])
    state = applyEvent(state, ev(3, { type: 'input.responded', inputId: 'q1', value: 'yes' }))
    expect(state.pendingInputs).toHaveLength(0)
  })

  it('restores the message queue from enqueued/dequeued events', () => {
    let state = applyEvent(initialReadModel(), ev(0, { type: 'session.created', session }))
    state = applyEvent(state, ev(1, { type: 'turn.started', turnId: 'turn_1' }))
    state = applyEvent(state, ev(2, { type: 'message.enqueued', text: 'first' }))
    state = applyEvent(state, ev(3, { type: 'message.enqueued', text: 'second' }))
    expect(state.queuedMessages).toEqual(['first', 'second'])
    state = applyEvent(state, ev(4, { type: 'message.dequeued', text: 'first' }))
    expect(state.queuedMessages).toEqual(['second'])
    // A full replay (reload path) restores the same queue.
    expect(projectEvents([
      ev(0, { type: 'session.created', session }),
      ev(1, { type: 'turn.started', turnId: 'turn_1' }),
      ev(2, { type: 'message.enqueued', text: 'first' }),
      ev(3, { type: 'message.enqueued', text: 'second' }),
      ev(4, { type: 'message.dequeued', text: 'first' }),
    ]).queuedMessages).toEqual(['second'])
    // Dequeuing unknown text is a no-op.
    const noop = applyEvent(
      projectEvents([ev(0, { type: 'session.created', session })]),
      ev(1, { type: 'message.dequeued', text: 'ghost' }),
    )
    expect(noop.queuedMessages).toEqual([])
  })

  it('accumulates token usage and keeps cost null until a price arrives', () => {
    let state = applyEvent(initialReadModel(), ev(0, { type: 'session.created', session }))
    expect(state.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: null })
    state = applyEvent(state, ev(1, { type: 'usage.recorded', inputTokens: 10, outputTokens: 4, costUsd: 0.01 }))
    state = applyEvent(state, ev(2, { type: 'usage.recorded', inputTokens: 5, outputTokens: 6, costUsd: null }))
    state = applyEvent(state, ev(3, { type: 'usage.recorded', inputTokens: 1, outputTokens: 2, costUsd: 0.005 }))
    expect(state.usage).toEqual({ inputTokens: 16, outputTokens: 12, costUsd: 0.015 })
  })

  it('projectEvents folds a full list in order', () => {
    const model = projectEvents([
      ev(0, { type: 'session.created', session }),
      ev(1, { type: 'user.message.added', message: { id: 'm1', sessionId: 'sess_1', turnId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], createdAt: 1001 } }),
    ])
    expect(model.messages).toHaveLength(1)
    expect(model.lastSeq).toBe(1)
  })
})
