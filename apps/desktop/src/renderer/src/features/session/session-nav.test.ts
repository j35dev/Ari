import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import { sidebarOrder } from './session-nav'

function row(id: string, updatedAt: number, flags: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    projectId: 'adhoc',
    title: id,
    updatedAt,
    messageCount: 1,
    ...flags,
  }
}

describe('sidebarOrder', () => {
  it('floats pinned sessions above recency ordering', () => {
    const ordered = sidebarOrder([
      row('fresh', 100),
      row('old-but-pinned', 10, { pinned: true }),
      row('middle', 50),
    ])
    expect(ordered.map((s) => s.id)).toEqual(['old-but-pinned', 'fresh', 'middle'])
  })

  it('hides archived sessions entirely', () => {
    const ordered = sidebarOrder([row('a', 2), row('gone', 9, { archived: true })])
    expect(ordered.map((s) => s.id)).toEqual(['a'])
  })

  it('does not mutate the input', () => {
    const input = [row('a', 1), row('b', 2)]
    sidebarOrder(input)
    expect(input.map((s) => s.id)).toEqual(['a', 'b'])
  })
})
