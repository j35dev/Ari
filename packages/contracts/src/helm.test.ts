import { expect, it } from 'vitest'
import {
  canSwitchProvider,
  isHelmProjectLead,
  isHelmProjectSession,
  visibleProjects,
  visibleSessions,
} from './helm'

it('keeps Aria outside project navigation and recognizes only its persistent project leads', () => {
  expect(visibleProjects([{ id: 'helm' }, { id: 'project' }])).toEqual([{ id: 'project' }])
  expect(visibleSessions([{ projectId: 'helm' }, { projectId: 'project' }])).toEqual([
    { projectId: 'project' },
  ])
  const lead = { projectId: 'project', lead: true, createdBy: { kind: 'session' } }
  expect(isHelmProjectLead(lead)).toBe(true)
  expect(canSwitchProvider(lead)).toBe(true)
  const direct = { projectId: 'project', createdBy: { kind: 'session' } }
  expect(isHelmProjectSession(direct)).toBe(true)
  expect(isHelmProjectLead(direct)).toBe(false)
  expect(canSwitchProvider(direct)).toBe(true)
  expect(canSwitchProvider({ projectId: 'helm' })).toBe(true)
  for (const other of [
    null,
    { ...lead, parentSessionId: 'parent' },
    { ...lead, projectId: 'helm' },
    { ...lead, createdBy: { kind: 'human' } },
  ]) {
    expect(isHelmProjectLead(other)).toBe(false)
    expect(canSwitchProvider(other)).toBe(other?.projectId === 'helm')
  }
})
