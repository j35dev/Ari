// @vitest-environment node
import { expect, it, vi } from 'vitest'
import type { Session } from '@ari/contracts/session'
import type { UnstampedEvent } from '@ari/engine/projection'
import type { Engine } from './engine'
import { DelegationApprovals } from './delegation-approvals'

const root: Session = {
  id: 'root',
  projectId: 'p',
  title: 'Parent',
  driverKind: 'claude',
  modelId: null,
  permissionMode: 'ask',
  status: 'running',
  createdAt: 1,
  updatedAt: 1,
}
it('routes first-use approval through durable cards and expires unanswered requests', async () => {
  vi.useFakeTimers()
  const events: UnstampedEvent[] = []
  const engine = {
    record: async (_id: string, event: UnstampedEvent) => {
      events.push(event)
    },
  } as unknown as Engine
  const approvals = new DelegationApprovals(engine)
  try {
    const allowed = approvals.request(root, 4)
    const event = events[0]
    if (event?.type !== 'approval.requested') throw new Error('Missing approval')
    expect(event.toolName).toBe('Ari delegation')
    expect(approvals.respond(event.approvalId, 'allow')).toBe(true)
    expect(await allowed).toBe(true)
    const expired = approvals.request(root, 4)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(await expired).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'approval.responded', decision: 'deny' })
    const cancelled = approvals.request(root, 4)
    approvals.cancel(root.id)
    expect(await cancelled).toBe(false)
    expect(approvals.respond('provider-approval', 'allow')).toBe(false)
  } finally {
    approvals.close()
    vi.useRealTimers()
  }
})
