import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import { sidebarGroups, sidebarOrder, UNFILED_GROUP_ID } from './session-nav'

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

const projects = [
  { id: 'p1', name: 'Ari' },
  { id: 'p2', name: 'Sketch' },
]

describe('sidebarGroups', () => {
  it('buckets sessions under each project in project order', () => {
    const groups = sidebarGroups(
      [row('a', 1, { projectId: 'p2' }), row('b', 2, { projectId: 'p1' })],
      projects,
    )
    expect(groups.map((g) => g.id)).toEqual(['p1', 'p2'])
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['b'])
    expect(groups[1]?.sessions.map((s) => s.id)).toEqual(['a'])
  })

  it('collects adhoc sessions into a trailing Unfiled group', () => {
    const groups = sidebarGroups([row('loose', 1), row('filed', 2, { projectId: 'p1' })], projects)
    expect(groups.at(-1)?.id).toBe(UNFILED_GROUP_ID)
    expect(groups.at(-1)?.sessions.map((s) => s.id)).toEqual(['loose'])
  })

  it('omits Unfiled when every session is filed', () => {
    const groups = sidebarGroups([row('filed', 2, { projectId: 'p1' })], projects)
    expect(groups.map((g) => g.id)).toEqual(['p1', 'p2'])
  })

  it('routes sessions of closed or unknown projects to Unfiled instead of hiding them', () => {
    const groups = sidebarGroups([row('orphan', 1, { projectId: 'closed' })], projects)
    expect(groups.at(-1)?.sessions.map((s) => s.id)).toEqual(['orphan'])
  })

  it('floats pinned sessions inside their own group only', () => {
    const groups = sidebarGroups(
      [
        row('fresh', 100, { projectId: 'p1' }),
        row('pinned', 1, { projectId: 'p1', pinned: true }),
        row('other', 50, { projectId: 'p2' }),
      ],
      projects,
    )
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['pinned', 'fresh'])
    expect(groups[1]?.sessions.map((s) => s.id)).toEqual(['other'])
  })

  it('excludes archived sessions from every group', () => {
    const groups = sidebarGroups(
      [row('live', 1, { projectId: 'p1' }), row('gone', 9, { projectId: 'p1', archived: true })],
      projects,
    )
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['live'])
  })
})

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

  it('walks the grouped order so keyboard traversal matches the render', () => {
    const sessions = [
      row('p2-new', 100, { projectId: 'p2' }),
      row('unfiled', 90),
      row('p1-old', 10, { projectId: 'p1' }),
      row('p1-pinned', 5, { projectId: 'p1', pinned: true }),
    ]
    // Groups first (project order), pinned first within a group, Unfiled last.
    expect(sidebarOrder(sessions, projects).map((s) => s.id)).toEqual([
      'p1-pinned',
      'p1-old',
      'p2-new',
      'unfiled',
    ])
    expect(sidebarOrder(sessions, projects).map((s) => s.id)).toEqual(
      sidebarGroups(sessions, projects).flatMap((g) => g.sessions.map((s) => s.id)),
    )
  })
})
