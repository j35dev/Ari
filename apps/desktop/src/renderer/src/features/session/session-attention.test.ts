import { expect, it } from 'vitest'
import { reduceSessionAttention } from './session-attention'

it('counts pending approval and question identities until each is answered or the turn settles', () => {
  let pending = reduceSessionAttention(new Set(), { type: 'approval.requested', approvalId: 'a' })
  const first = pending
  pending = reduceSessionAttention(pending, { type: 'approval.requested', approvalId: 'a' })
  expect(pending).toBe(first)
  pending = reduceSessionAttention(pending, { type: 'input.requested', inputId: 'a' })
  expect(pending.size).toBe(2)
  pending = reduceSessionAttention(pending, { type: 'approval.responded', approvalId: 'a' })
  expect(pending.size).toBe(1)
  expect(reduceSessionAttention(pending, { type: 'turn.settled' }).size).toBe(0)
})
