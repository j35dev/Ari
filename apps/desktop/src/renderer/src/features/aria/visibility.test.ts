import { expect, it } from 'vitest'
import { visibleProjects, visibleSessions } from './visibility'

it('hides Aria from projects and sessions while retaining other records in order', () => {
  const projects = [{ id: 'a' }, { id: 'helm' }, { id: 'b' }]
  const sessions = [
    { projectId: 'helm', archived: true },
    { projectId: 'a' },
    { projectId: 'helm' },
    { projectId: 'adhoc' },
  ]
  expect(visibleProjects(projects)).toEqual([projects[0], projects[2]])
  expect(visibleSessions(sessions)).toEqual([sessions[1], sessions[3]])
  expect(projects).toHaveLength(3)
  expect(sessions).toHaveLength(4)
})
