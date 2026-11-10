import { expect, it } from 'vitest'
import { controlParams } from './agent-control'
import { navigateFrameSchema, appOpenReceiptSchema, rpcParams } from './rpc'

it('accepts only the four navigation targets with bounded exact context', () => {
  for (const value of [
    { view: 'session', sessionId: 'exact' },
    { view: 'aria' },
    { view: 'settings' },
    { view: 'changes', projectId: 'project' },
    { view: 'changes', sessionId: 'exact' },
  ])
    expect(controlParams['app.open'].safeParse({ ...value, idempotencyKey: 'key' }).success).toBe(
      true,
    )
  for (const value of [
    { view: 'changes' },
    { view: 'changes', projectId: 'p', sessionId: 's' },
    { view: 'session', sessionId: '' },
    { view: 'settings', url: 'file://anything' },
    { view: 'aria', sessionId: 'old' },
    { view: 'settings', execute: 'anything' },
  ])
    expect(controlParams['app.open'].safeParse({ ...value, idempotencyKey: 'key' }).success).toBe(
      false,
    )
})

it('validates targeted frames and observations instead of arbitrary payload casts', () => {
  const target = { view: 'session', sessionId: 's' }
  const receipt = { requestId: 'r', target, status: 'applied', observed: { target, mode: 'chat' } }
  expect(appOpenReceiptSchema.safeParse(receipt).success).toBe(true)
  for (const raw of [
    { ...receipt, observed: undefined },
    { ...receipt, observed: { target: { ...target, sessionId: 'other' }, mode: 'chat' } },
    { ...receipt, observed: { target, mode: 'settings' } },
    { ...receipt, status: 'unconfirmed' },
    { ...receipt, extra: true },
  ])
    expect(appOpenReceiptSchema.safeParse(raw).success).toBe(false)
  expect(navigateFrameSchema.safeParse({ sessionId: 's' }).success).toBe(true)
  expect(navigateFrameSchema.safeParse({ settingsSection: 'speech' }).success).toBe(true)
  expect(
    navigateFrameSchema.safeParse({
      kind: 'app.open',
      consumerId: 'c',
      requestId: 'r',
      expiresAt: 1,
      target,
    }).success,
  ).toBe(true)
  expect(navigateFrameSchema.safeParse({ kind: 'app.open', requestId: 'r', target }).success).toBe(
    false,
  )
  expect(rpcParams['app.navigation.ack'].safeParse({ consumerId: 'c', receipt }).success).toBe(true)
  expect(
    rpcParams['app.navigation.ack'].safeParse({ consumerId: 'c', receipt, command: 'anything' })
      .success,
  ).toBe(false)
})
