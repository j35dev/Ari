import { expect, it } from 'vitest'
import { visibleProjects, visibleSessions } from './visibility'

it('keeps Aria out of the mobile project picker and home session list', () => {
  expect(visibleProjects([{ id: 'helm' }, { id: 'project' }])).toEqual([{ id: 'project' }])
  expect(visibleSessions([{ projectId: 'helm' }, { projectId: 'project' }])).toEqual([
    { projectId: 'project' },
  ])
})
