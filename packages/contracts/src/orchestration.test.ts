import { expect, it } from 'vitest'
import { orchestrationParams } from './orchestration'
import { ROUTINE_MIN_EVERY_MS } from './agent-control'

it('requires exact result identity and safe literal file paths for pinned review', () => {
  const target = {
    sessionId: 'parent',
    taskId: 'task',
    resultId: 'result',
    attemptId: 'attempt',
    version: 1,
    snapshotCommit: 'a'.repeat(40),
    kind: 'files',
  }
  const schema = orchestrationParams['orchestration.result.diff']
  expect(schema.parse(target)).toEqual(target)
  for (const omitted of ['resultId', 'attemptId', 'version', 'snapshotCommit']) {
    const missing: Record<string, unknown> = { ...target }
    delete missing[omitted]
    expect(schema.safeParse(missing).success).toBe(false)
  }
  const file = {
    ...target,
    kind: 'file',
    baseCommit: 'b'.repeat(40),
    path: 'new [日本語].ts',
    oldPath: 'old.ts',
  }
  expect(schema.parse(file)).toEqual(file)
  for (const path of ['../outside', 'C:/outside', '/outside', 'bad\0path'])
    expect(schema.safeParse({ ...file, path }).success).toBe(false)
  expect(schema.safeParse({ ...file, oldPath: '../outside' }).success).toBe(false)
  expect(schema.safeParse({ ...file, baseCommit: undefined }).success).toBe(false)
  expect(schema.safeParse({ ...target, patch: true }).success).toBe(false)
})

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
