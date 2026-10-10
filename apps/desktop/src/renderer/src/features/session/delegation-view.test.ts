import { describe, expect, it } from 'vitest'
import type { ChildTask } from '@ari/contracts/agent-control'
import { delegatedChildren, delegatedChildState, type SpawnRecord } from './delegation-view'

const task = (overrides: Partial<ChildTask> = {}): ChildTask => ({
  sessionId: 'child',
  parentSessionId: 'root',
  title: 'Parser',
  role: 'review',
  driverKind: 'codex',
  modelId: 'gpt',
  workState: 'result_available',
  blockedOn: null,
  queuedMessages: 0,
  latestTurn: { turnId: 't', stopReason: 'completed', settledAt: 5 },
  report: 'Two findings.',
  reportTruncated: false,
  delivered: true,
  workspaceKind: 'project',
  branch: null,
  ...overrides,
})
const settledAs = (stopReason: 'completed' | 'interrupted' | 'error') =>
  task({ latestTurn: { turnId: 't', stopReason, settledAt: 5 } })

describe('delegatedChildState', () => {
  it('lets live activity decide while a turn runs', () => {
    expect(delegatedChildState(task(), { phase: 'working', startedAt: 1 }, false)).toBe('working')
    expect(delegatedChildState(task(), { phase: 'paused', startedAt: 1 }, false)).toBe('needs-you')
  })

  it('reads how a finished turn ended from the task', () => {
    expect(delegatedChildState(settledAs('completed'), undefined, false)).toBe('done')
    expect(delegatedChildState(settledAs('error'), undefined, false)).toBe('failed')
    expect(delegatedChildState(settledAs('interrupted'), undefined, false)).toBe('stopped')
    expect(delegatedChildState(task({ workState: 'waiting_for_children' }), undefined, false)).toBe(
      'waiting',
    )
    expect(delegatedChildState(task({ workState: 'blocked_on_user' }), undefined, false)).toBe(
      'needs-you',
    )
    expect(delegatedChildState(task({ workState: 'not_started' }), undefined, false)).toBe('idle')
  })

  it('falls back to activity before the first snapshot and marks removed children', () => {
    expect(delegatedChildState(undefined, { phase: 'done', startedAt: null }, false)).toBe('done')
    expect(delegatedChildState(undefined, { phase: 'error', startedAt: null }, false)).toBe('failed')
    expect(delegatedChildState(undefined, undefined, false)).toBe('idle')
    expect(delegatedChildState(task(), { phase: 'working', startedAt: 1 }, true)).toBe('removed')
  })
})

it('joins spawn history with the task snapshot, preferring its current title', () => {
  const spawn: SpawnRecord = {
    sessionId: 'child',
    title: 'Worker',
    role: null,
    driverKind: 'claude',
    modelId: null,
    anchor: { messageId: 'a1', partIndex: 2 },
    destroyed: false,
  }
  expect(delegatedChildren([spawn], [task()])).toEqual([
    {
      sessionId: 'child',
      title: 'Parser',
      role: 'review',
      driverKind: 'codex',
      modelId: 'gpt',
      state: 'done',
      startedAt: null,
      report: 'Two findings.',
      anchor: { messageId: 'a1', partIndex: 2 },
    },
  ])
  expect(
    delegatedChildren([spawn], [], () => ({ phase: 'working', startedAt: 42 }))[0],
  ).toMatchObject({ title: 'Worker', state: 'working', startedAt: 42, report: null })
})
