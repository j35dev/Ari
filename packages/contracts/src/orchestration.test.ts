import { expect, it } from 'vitest'
import { orchestrationParams } from './orchestration'
import { ROUTINE_MIN_EVERY_MS } from './agent-control'

it('keeps retry guards optional and distinguishes explicit null from omission', () => {
  const base = { sessionId: 'parent', taskId: 'task', idempotencyKey: 'retry' }
  const legacy = orchestrationParams['orchestration.retry'].parse(base)
  expect(legacy).not.toHaveProperty('expectedResultId')
  expect(legacy).not.toHaveProperty('expectedSnapshotCommit')
  expect(
    orchestrationParams['orchestration.retry'].parse({
      ...base,
      expectedResultId: null,
      expectedAttemptId: 'attempt',
      expectedSnapshotCommit: null,
    }),
  ).toMatchObject({
    expectedResultId: null,
    expectedAttemptId: 'attempt',
    expectedSnapshotCommit: null,
  })
  expect(
    orchestrationParams['orchestration.retry'].safeParse({ ...base, expectedSnapshotCommit: 'bad' })
      .success,
  ).toBe(false)
})

it('accepts empty question dismissal without changing the answer payload shape', () => {
  expect(
    orchestrationParams['orchestration.answer'].parse({
      sessionId: 'parent',
      childSessionId: 'child',
      requestId: 'question',
      kind: 'question',
      value: '',
      idempotencyKey: 'skip',
    }),
  ).toMatchObject({ value: '', kind: 'question' })
})

it('keeps renderer routine validation aligned with the existing scheduler floor', () => {
  const routine = {
    sessionId: 'parent',
    prompt: 'Follow up',
    at: 1,
    everyMs: ROUTINE_MIN_EVERY_MS,
    idempotencyKey: 'schedule',
  }
  expect(orchestrationParams['orchestration.routine.add'].safeParse(routine).success).toBe(true)
  expect(
    orchestrationParams['orchestration.routine.add'].safeParse({
      ...routine,
      everyMs: ROUTINE_MIN_EVERY_MS - 1,
    }).success,
  ).toBe(false)
  expect(orchestrationParams['orchestration.routine.list'].parse({ sessionId: 'parent' })).toEqual({
    sessionId: 'parent',
    recursive: false,
  })
})
