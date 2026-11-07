import { expect, it } from 'vitest'
import { agentEventSchema } from './agent-event'
import { journalEventSchema } from './events'
import { coordinationMessageSchema } from './coordination'
import { controlParams } from './agent-control'

it('preserves optional provider ownership in normalized and journaled lifecycle events', () => {
  const identity = { providerThreadId: 'thread', providerTurnId: 'turn', providerItemId: 'item' }
  expect(
    agentEventSchema.parse({
      type: 'background-task',
      id: 'task',
      kind: 'subagent',
      label: 'Child',
      status: 'completed',
      ...identity,
    }),
  ).toMatchObject(identity)
  expect(
    agentEventSchema.parse({
      type: 'approval-requested',
      approvalId: 'request',
      toolName: 'Bash',
      summaryJson: '{}',
      ...identity,
    }),
  ).toMatchObject(identity)
  expect(
    journalEventSchema.parse({
      type: 'approval.requested',
      seq: 0,
      sessionId: 'owner',
      at: 1,
      approvalId: 'request',
      toolName: 'Bash',
      summaryJson: '{}',
      ...identity,
    }),
  ).toMatchObject(identity)
  expect(agentEventSchema.parse({ type: 'done', stopReason: 'interrupted' })).toEqual({
    type: 'done',
    stopReason: 'interrupted',
  })
  expect(agentEventSchema.parse({ type: 'done' })).toEqual({ type: 'done' })
})

it('keeps coordination consumption and retrieval explicit and scoped', () => {
  expect(controlParams['session.inbox'].parse({})).toEqual({ includeConsumed: false })
  expect(
    controlParams['session.ack'].safeParse({ messageIds: [], idempotencyKey: 'empty' }).success,
  ).toBe(false)
  expect(
    coordinationMessageSchema.safeParse({
      messageId: 'id',
      senderSessionId: 'sender',
      recipientSessionId: 'recipient',
      text: 'message',
      createdAt: 1,
      status: 'uncertain',
      turnId: null,
      consumedAt: null,
    }).success,
  ).toBe(true)
})
