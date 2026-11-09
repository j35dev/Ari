import { HELM_PROJECT_ID } from '@ari/contracts/helm'

export function visibleProjects<T extends { id: string }>(projects: readonly T[]): T[] {
  return projects.filter((project) => project.id !== HELM_PROJECT_ID)
}

export function visibleSessions<T extends { projectId: string }>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => session.projectId !== HELM_PROJECT_ID)
}
