import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import { applyPatches, dropSettled, type PendingPatch } from './session-patches'

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  projectId: 'proj',
  title: id,
  updatedAt: 0,
  messageCount: 1,
  ...extra,
})

describe('applyPatches', () => {
  it('returns the list itself when nothing is pending', () => {
    const listed = [session('a')]
    expect(applyPatches(listed, [])).toBe(listed)
  })

  it('overlays pending changes, the newest winning', () => {
    const listed = [session('a'), session('b')]
    const patches: PendingPatch[] = [
      { token: 1, sessionId: 'a', patch: { pinned: true, title: 'First' } },
      { token: 2, sessionId: 'a', patch: { title: 'Second' } },
    ]
    expect(applyPatches(listed, patches)).toEqual([
      session('a', { pinned: true, title: 'Second' }),
      session('b'),
    ])
  })
})

describe('dropSettled', () => {
  const patches: PendingPatch[] = [
    { token: 1, sessionId: 'a', patch: { pinned: true } },
    { token: 2, sessionId: 'b', patch: { archived: true }, settledAt: 4 },
  ]

  it('keeps a settled patch until a list fetched after it lands', () => {
    expect(dropSettled(patches, 3)).toBe(patches)
  })

  it('drops it once that list has landed, but never an unconfirmed one', () => {
    expect(dropSettled(patches, 4)).toEqual([patches[0]])
  })
})
