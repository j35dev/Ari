import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import {
  inboxSplit,
  moveProjectInList,
  projectMoveForDelta,
  projectMoveFromOrder,
  sessionsViewOrder,
  shellRootFor,
  sidebarGroups,
  sidebarOrder,
  UNFILED_GROUP_ID,
} from './session-nav'

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

describe('projectMoveFromOrder', () => {
  it('slots the dragged project ahead of its new successor', () => {
    expect(projectMoveFromOrder(['a', 'b', 'c'], ['a', 'c', 'b'], 'b')).toEqual({
      id: 'b',
      beforeId: null,
    })
    expect(projectMoveFromOrder(['a', 'b', 'c'], ['c', 'a', 'b'], 'c')).toEqual({
      id: 'c',
      beforeId: 'a',
    })
  })

  it('returns null for a press or a drop back onto the original slot', () => {
    expect(projectMoveFromOrder(['a', 'b', 'c'], ['a', 'b', 'c'], 'b')).toBeNull()
    expect(projectMoveFromOrder(['a', 'b', 'c'], ['a', 'b', 'c'], 'gone')).toBeNull()
  })
})

describe('projectMoveForDelta', () => {
  const ids = ['a', 'b', 'c']

  it('swaps with the neighbour above and below', () => {
    expect(projectMoveForDelta(ids, 'b', -1)).toEqual({ id: 'b', beforeId: 'a' })
    expect(projectMoveForDelta(ids, 'b', 1)).toEqual({ id: 'b', beforeId: null })
    expect(projectMoveForDelta(ids, 'a', 1)).toEqual({ id: 'a', beforeId: 'c' })
    expect(projectMoveForDelta(ids, 'c', -1)).toEqual({ id: 'c', beforeId: 'b' })
  })

  it('refuses to nudge past the edges', () => {
    expect(projectMoveForDelta(ids, 'a', -1)).toBeNull()
    expect(projectMoveForDelta(ids, 'c', 1)).toBeNull()
    expect(projectMoveForDelta(ids, 'gone', 1)).toBeNull()
  })
})

describe('moveProjectInList', () => {
  const list = [
    { id: 'a', open: true },
    { id: 'closed', open: false },
    { id: 'b', open: true },
  ]

  it('mirrors the stored splice, closed projects included', () => {
    expect(moveProjectInList(list, 'b', 'a').map((p) => p.id)).toEqual(['b', 'a', 'closed'])
    expect(moveProjectInList(list, 'b', null).map((p) => p.id)).toEqual(['a', 'closed', 'b'])
    expect(moveProjectInList(list, 'b', 'closed').map((p) => p.id)).toEqual(['a', 'b', 'closed'])
  })

  it('leaves the list untouched for unknown ids', () => {
    expect(moveProjectInList(list, 'gone', 'a')).toBe(list)
    expect(moveProjectInList(list, 'a', 'gone')).toBe(list)
  })
})

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

describe('shellRootFor', () => {
  const registered = [
    { id: 'p1', path: 'D:\\Projects\\Ari' },
    { id: 'p2', path: 'D:\\Projects\\Sketch' },
  ]

  it('gives a session its own project folder', () => {
    expect(shellRootFor(row('filed', 1, { projectId: 'p2' }), null, registered)).toBe(
      'D:\\Projects\\Sketch',
    )
  })

  it('refuses the home directory an ad-hoc session resolves to', () => {
    // `resolveWorkspace` answers the home directory for this bucket, so the
    // path comes back clean — and is still one the jail never accepts.
    expect(shellRootFor(row('loose', 1), 'C:\\Users\\me', registered)).toBeNull()
  })

  it('keeps the workspace a managed worktree already has', () => {
    expect(shellRootFor(row('wt', 1, { projectId: 'p1' }), 'D:\\worktrees\\abc', registered)).toBe(
      'D:\\worktrees\\abc',
    )
  })

  it('keeps that worktree after the project behind it is removed', () => {
    // A worktree is a trusted root in its own right, so a session cut against
    // a folder that has since left the registry keeps its shell.
    expect(
      shellRootFor(row('wt', 1, { projectId: 'gone' }), 'D:\\worktrees\\abc', registered),
    ).toBe('D:\\worktrees\\abc')
  })

  it('offers no shell for a session whose project was removed', () => {
    expect(shellRootFor(row('orphan', 1, { projectId: 'gone' }), null, registered)).toBeNull()
  })

  it('answers with the project folder while the workspace is still resolving', () => {
    // `session.workspace` lands a beat late on a session switch; the project
    // folder is one the jail accepts anyway, so the rail need not blink.
    expect(shellRootFor(row('filed', 1, { projectId: 'p1' }), null, registered)).toBe(
      'D:\\Projects\\Ari',
    )
  })

  it('roots wherever the caller points it when no session is selected', () => {
    expect(shellRootFor(undefined, 'D:\\Projects\\Ari', registered)).toBe('D:\\Projects\\Ari')
    expect(shellRootFor(undefined, null, [])).toBeNull()
  })
})

describe('inboxSplit', () => {
  const sessions = [
    row('run', 1),
    row('run-child', 2, { parentSessionId: 'run' }),
    row('idle', 3),
    row('idle-child', 4, { parentSessionId: 'idle' }),
    row('pinned', 5, { pinned: true }),
    row('archived', 6, { archived: true }),
    row('pinned-child', 7, { parentSessionId: 'pinned' }),
  ]

  it('keeps running and settled roots in the card lists and hides child agents', () => {
    const split = inboxSplit(sessions)
    expect(split.pinned.map((s) => s.id)).toEqual(['pinned'])
    expect(split.active.map((s) => s.id)).toEqual(['idle', 'run'])
    expect([...split.pinned, ...split.active].some((s) => s.parentSessionId)).toBe(false)
  })

  it('drops archived sessions from every list', () => {
    const split = inboxSplit(sessions)
    expect(split.pinned.some((s) => s.id === 'archived')).toBe(false)
    expect(split.active.some((s) => s.id === 'archived')).toBe(false)
  })
})

describe('sessionsViewOrder', () => {
  it('walks pinned roots then active roots, including ones still working', () => {
    const order = sessionsViewOrder([
      row('run', 1),
      row('run-child', 2, { parentSessionId: 'run' }),
      row('idle', 3),
      row('pinned', 5, { pinned: true }),
    ])
    expect(order.map((s) => s.id)).toEqual(['pinned', 'idle', 'run'])
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
