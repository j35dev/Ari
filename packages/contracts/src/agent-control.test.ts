import { expect, it } from 'vitest'
import { controlParams } from './agent-control'

it('keeps read defaults and the existing message/character bounds at the control boundary', () => {
  expect(controlParams['session.read'].parse({ targetSessionId: 'worker' })).toMatchObject({
    tailMessages: 6,
    maxChars: 16_000,
  })
  expect(
    controlParams['session.read'].parse({
      targetSessionId: 'worker',
      tailMessages: 200,
      maxChars: 100_000,
      tailTurns: 1,
    }),
  ).toMatchObject({ tailMessages: 200, maxChars: 100_000 })
  for (const extra of [
    { tailMessages: 0 },
    { tailMessages: 201 },
    { maxChars: 0 },
    { maxChars: 100_001 },
  ]) {
    expect(
      controlParams['session.read'].safeParse({ targetSessionId: 'worker', ...extra }).success,
    ).toBe(false)
  }
})

it('requires an explicit catalog model and keeps self switches free of permission overrides', () => {
  const params = {
    targetSessionId: 'self',
    driverKind: 'codex',
    modelId: 'chosen',
    idempotencyKey: 'explicit',
  }
  expect(controlParams['session.switch'].parse(params)).toEqual(params)
  expect(controlParams['session.switch'].safeParse({ ...params, modelId: undefined }).success).toBe(
    false,
  )
  expect(
    controlParams['session.switch'].safeParse({ ...params, permissionMode: 'full' }).success,
  ).toBe(false)
})
