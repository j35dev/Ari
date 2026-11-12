import type { SessionSummary } from '@ari/contracts/rpc'

export interface RepositoryIdentity {
  canonicalKey: string
  originKey?: string | null
  label?: string | null
}
/** Renderer projection only. Host project IDs remain inside each checkout. */
export interface ProjectCheckout {
  hostId: string
  hostName: string
  projectId: string
  name: string
  checkoutLabel: string
  repository: RepositoryIdentity | null
  local: boolean
}
export interface RepositoryGroup {
  id: string
  name: string
  label: string | null
  checkouts: ProjectCheckout[]
}

export function repositoryGroupKey(project: ProjectCheckout): string {
  const identity = project.repository
  if (!identity?.canonicalKey) return `checkout:${JSON.stringify([project.hostId, project.projectId])}`
  // A differing origin is the fork's identity even when upstream is shared.
  return `repository:${JSON.stringify(identity.originKey || identity.canonicalKey)}`
}

export function groupRepositories(projects: readonly ProjectCheckout[]): RepositoryGroup[] {
  const groups = new Map<string, RepositoryGroup>()
  for (const project of projects) {
    const id = repositoryGroupKey(project)
    const group = groups.get(id) ?? {
      id, name: project.name,
      label: project.repository?.originKey && project.repository.originKey !== project.repository.canonicalKey
        ? project.repository.label ?? project.repository.originKey : null,
      checkouts: [],
    }
    if (!group.checkouts.some((p) => p.hostId === project.hostId && p.projectId === project.projectId))
      group.checkouts.push(project)
    // Prefer the local name; retain a host label only for exclusively remote projects.
    if (project.local) group.name = project.name
    groups.set(id, group)
  }
  return [...groups.values()]
}

export function checkoutChoices(group: RepositoryGroup, hostId: string): ProjectCheckout[] {
  return group.checkouts.filter((checkout) => checkout.hostId === hostId)
}

/** Sidebar IDs are presentation keys. No projected ID is filesystem/RPC authority. */
export function projectSessionSummary(
  summary: SessionSummary,
  viewKey: (sessionId: string) => string,
  groupId: string,
): SessionSummary {
  return {
    ...summary, id: viewKey(summary.id), projectId: groupId,
    parentSessionId: summary.parentSessionId ? viewKey(summary.parentSessionId) : null,
  }
}
