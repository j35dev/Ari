import { expect, it } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import { sessionTree, searchSessionTree } from './session-tree'

const row = (id: string, parentSessionId?: string): SessionSummary => ({
  id,
  parentSessionId,
  title: id,
  projectId: 'p',
  updatedAt: 1,
  messageCount: 0,
})
it('nests recent children under their parent, including after collapse and search', () => {
  const sessions = [row('child', 'root'), row('root'), row('other')]
  expect(sessionTree(sessions).map((r) => [r.session.id, r.depth, r.lastAtDepth])).toEqual([
    ['root', 0, []],
    ['child', 1, [true]],
    ['other', 0, []],
  ])
  expect(sessionTree(sessions, new Set(['root'])).map((r) => r.session.id)).toEqual([
    'root',
    'other',
  ])
  expect(searchSessionTree(sessions, 'child').map((r) => r.id)).toEqual(['child', 'root'])
})

it('marks last siblings so the sidebar can draw elbows', () => {
  const sessions = [row('root'), row('a', 'root'), row('b', 'root'), row('a1', 'a')]
  expect(sessionTree(sessions).map((r) => [r.session.id, r.lastAtDepth])).toEqual([
    ['root', []],
    ['a', [false]],
    ['a1', [false, true]],
    ['b', [true]],
  ])
})
it('retains orphans and corrupt cycles exactly once', () => {
  expect(
    sessionTree([row('a', 'b'), row('b', 'a'), row('orphan', 'missing')])
      .map((r) => r.session.id)
      .sort(),
  ).toEqual(['a', 'b', 'orphan'])
})
