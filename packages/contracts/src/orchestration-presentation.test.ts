import { describe, expect, it } from 'vitest'
import type { ChildTask } from './agent-control'
import type { OrchestrationTask } from './orchestration'
import { presentChildTask, presentOrchestrationTask } from './orchestration-presentation'

describe('work presentation', () => {
  it('separates queued work and lead-owned decisions from active execution', () => {
    expect(presentChildTask({ workState: 'queued' } as ChildTask)).toEqual({
      state: 'queued',
      label: 'Queued',
      live: true,
      attentionOwner: null,
    })
    expect(presentChildTask({ workState: 'blocked_on_parent' } as ChildTask)).toEqual({
      state: 'needs-lead',
      label: 'Needs lead',
      live: true,
      attentionOwner: 'lead',
    })
    expect(presentChildTask({ workState: 'blocked_on_user' } as ChildTask).attentionOwner).toBe(
      'human',
    )
  })
  it('keeps execution completion, acceptance, and integration distinct', () => {
    const task = {
      currentActivity: { phase: 'ended', terminalStatus: 'completed', decisionOwner: null },
      currentResultId: 'r',
      results: [{ resultId: 'r', reviewState: 'available' }],
    } as OrchestrationTask
    expect(presentOrchestrationTask(task).label).toBe('Result ready')
    task.results[0]!.reviewState = 'accepted'
    expect(presentOrchestrationTask(task)).toMatchObject({
      state: 'completed',
      label: 'Accepted',
      live: false,
    })
    task.results[0]!.reviewState = 'integrated'
    expect(presentOrchestrationTask(task).label).toBe('Integrated')
  })
  it('retains unknown outcomes without classifying them as failure', () => {
    const task = { currentActivity: { phase: 'unknown', decisionOwner: null } } as OrchestrationTask
    expect(presentOrchestrationTask(task)).toMatchObject({
      state: 'unknown',
      label: 'Activity unknown',
      live: false,
    })
  })
  it('keeps a finished change request actionable without claiming a live turn', () => {
    const task = {
      currentActivity: {
        phase: 'ended',
        terminalStatus: 'completed',
        decisionOwner: null,
        freshness: 'journal',
      },
      currentResultId: 'r',
      results: [{ resultId: 'r', reviewState: 'changes_requested' }],
    } as OrchestrationTask
    expect(presentChildTask(task)).toEqual({
      state: 'needs-lead',
      label: 'Changes requested',
      live: false,
      attentionOwner: 'lead',
    })
  })
  it('requires an observed live connection for a view row to claim ongoing activity', () => {
    const task = {
      currentActivity: { phase: 'working', decisionOwner: null, freshness: 'journal' },
    } as OrchestrationTask
    expect(presentOrchestrationTask(task)).toMatchObject({ state: 'working', live: false })
    task.currentActivity.freshness = 'live'
    expect(presentOrchestrationTask(task).live).toBe(true)
  })
})
