import { describe, expect, it } from 'vitest'
import type { ChildTask } from '@ari/contracts/agent-control'
import {
  agentState,
  agentsStatus,
  agentsSummary,
  byUrgency,
  delegationUpdate,
  isLive,
} from './delegation'

const task = (overrides: Partial<ChildTask> = {}): ChildTask => ({
  sessionId: 'c',
  parentSessionId: 'p',
  title: 'Parser',
  role: 'review',
  driverKind: 'claude',
  modelId: null,
  workState: 'result_available',
  blockedOn: null,
  queuedMessages: 0,
  latestTurn: { turnId: 't', stopReason: 'completed', settledAt: 1 },
  report: 'Done.',
  reportTruncated: false,
  delivered: true,
  workspaceKind: 'project',
  branch: null,
  ...overrides,
})
const settled = (stopReason: 'completed' | 'interrupted' | 'error'): ChildTask =>
  task({ latestTurn: { turnId: 't', stopReason, settledAt: 1 } })

describe('agentState', () => {
  it('reads a settled child by how its turn ended', () => {
    expect(agentState(settled('completed'))).toBe('done')
    expect(agentState(settled('error'))).toBe('failed')
    expect(agentState(settled('interrupted'))).toBe('stopped')
  })

  it('separates working, blocked on the user, and waiting on its own agents', () => {
    expect(agentState(task({ workState: 'working' }))).toBe('working')
    expect(agentState(task({ workState: 'blocked_on_user' }))).toBe('needs-you')
    expect(agentState(task({ workState: 'waiting_for_children' }))).toBe('waiting')
    expect(agentState(task({ workState: 'not_started' }))).toBe('idle')
    expect(['working', 'needs-you', 'waiting'].every((state) => isLive(state as never))).toBe(true)
    expect(isLive('done')).toBe(false)
  })
})

it('summarizes a group most urgent first', () => {
  expect(
    agentsSummary([
      settled('completed'),
      task({ workState: 'working' }),
      task({ workState: 'working' }),
      task({ workState: 'blocked_on_user' }),
    ]),
  ).toBe('4 agents · 1 needs you · 2 working · 1 done')
  expect(agentsSummary([settled('error')])).toBe('1 agent · 1 failed')
})

it('puts the agent that needs the user first and says what the session is waiting on', () => {
  const tasks = [
    { ...settled('completed'), sessionId: 'done' },
    task({ sessionId: 'busy', workState: 'working' }),
    task({ sessionId: 'ask', workState: 'blocked_on_user' }),
  ]
  expect(byUrgency(tasks).map((entry) => entry.sessionId)).toEqual(['ask', 'busy', 'done'])
  expect(agentsStatus(tasks)).toBe('1 agent needs you')
  expect(agentsStatus(tasks.slice(0, 2))).toBe('waiting on 1 agent')
  expect(
    agentsStatus([task({ workState: 'working' }), task({ workState: 'waiting_for_children' })]),
  ).toBe('waiting on 2 agents')
  expect(agentsStatus([settled('completed'), settled('interrupted')])).toBeNull()
})

describe('delegationUpdate', () => {
  const titles: Record<string, string> = { a: 'Parser', b: 'Docs', c: 'Tests' }
  const titleOf = (id: string): string | undefined => titles[id]

  it('names who reported and drops Ari’s preface from the body', () => {
    const text =
      '[Ari delegation update: added automatically by Ari, not written by the user.]\n\nChild session "Parser" (a) finished its turn.\nReport:\nFixed.'
    expect(delegationUpdate(text, ['a'], titleOf)).toEqual({
      headline: 'Parser reported back',
      body: 'Child session "Parser" (a) finished its turn.\nReport:\nFixed.',
    })
    expect(delegationUpdate(text, ['a', 'b'], titleOf).headline).toBe('Parser and Docs reported back')
    expect(delegationUpdate(text, ['a', 'b', 'c'], titleOf).headline).toBe(
      'Parser and 2 others reported back',
    )
    expect(delegationUpdate(text, ['gone'], titleOf).headline).toBe('A removed session reported back')
  })

  it('says so when every child in the update failed', () => {
    const text = 'Child session "Tests" (c) failed.\nError: rate limit'
    expect(delegationUpdate(text, ['c'], titleOf).headline).toBe('Tests failed')
  })
})
