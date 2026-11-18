import { describe, expect, it } from 'vitest'
import type { Session } from '@ari/contracts/session'
import type { ExternalSource } from '@ari/contracts/external'
import { initialReadModel, applyEvent } from './projection'
import { decideCommand, previewDispatch } from './dispatcher'

const session: Session = {
  id: 'task',
  projectId: 'project',
  title: 'Slack task',
  driverKind: 'claude',
  modelId: 'model',
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
}
const source: ExternalSource = {
  platform: 'slack',
  connectorId: 'connector',
  requestId: 'first',
  workspaceId: 'T123',
  channelId: 'C123',
  threadId: '1.000001',
  senderId: 'U123',
}
const model = () =>
  applyEvent(initialReadModel(), {
    type: 'session.created',
    session,
    sessionId: session.id,
    seq: 0,
    at: 1,
  })

describe('external message journals', () => {
  it('preserves external attribution for initial turns and two identical queued follow-ups', () => {
    const start = decideCommand(
      model(),
      {
        type: 'turn.start',
        sessionId: session.id,
        text: 'Initial',
        attachments: [],
        externalSource: source,
      },
      { turnId: 'turn', messageId: 'message' },
    )
    let state = previewDispatch(model(), start)
    expect(state.messages[0]?.externalSource).toEqual(source)
    for (const requestId of ['second', 'third'])
      state = previewDispatch(
        state,
        decideCommand(
          state,
          {
            type: 'message.enqueue',
            sessionId: session.id,
            text: 'Same text',
            attachments: [],
            externalSource: { ...source, requestId },
          },
          { turnId: `turn_${requestId}`, messageId: `message_${requestId}` },
        ),
      )
    expect(state.queuedMessages.map((message) => message.externalSource?.requestId)).toEqual([
      'second',
      'third',
    ])
    const dequeue = decideCommand(
      state,
      { type: 'message.dequeue', sessionId: session.id, text: 'Same text', attachments: [] },
      { turnId: 'unused', messageId: 'unused' },
    )
    state = previewDispatch(state, dequeue)
    expect(state.queuedMessages.map((message) => message.externalSource?.requestId)).toEqual([
      'third',
    ])
  })

  it('rejects an approval callback when its turn changed even if the provider reuses its ID', () => {
    let state = applyEvent(model(), {
      type: 'turn.started',
      sessionId: session.id,
      turnId: 'new_turn',
      seq: 1,
      at: 2,
    })
    state = applyEvent(state, {
      type: 'approval.requested',
      sessionId: session.id,
      seq: 2,
      at: 3,
      approvalId: 'reused',
      toolName: 'shell',
      summaryJson: '{}',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    })
    const result = decideCommand(
      state,
      {
        type: 'approval.respond',
        sessionId: session.id,
        approvalId: 'reused',
        optionId: 'allow',
        expectedTurnId: 'old_turn',
      },
      { turnId: 'unused', messageId: 'unused' },
    )
    expect(result.accepted).toBe(false)
    expect(result.events).toEqual([])
    expect(state.pendingApprovals).toHaveLength(1)
  })
})
