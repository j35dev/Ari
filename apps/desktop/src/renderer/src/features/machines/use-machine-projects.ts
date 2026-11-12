import { useMemo } from 'react'
import type { SessionSummary } from '@ari/contracts/rpc'
import type { Project } from '@ari/contracts/project'
import { sessionViewKey, type SessionScope } from '../session/session-client'
import { groupRepositories, projectSessionSummary, type ProjectCheckout } from './repository-groups'
import { useMachines } from './use-machines'

export function useMachineProjects(projects: Project[], localSessions: SessionSummary[]) {
  const { machines, local, inventories } = useMachines()
  return useMemo(() => {
    const checkouts: ProjectCheckout[] = projects.map((project) => {
      const identity = local?.catalog.projects.find((entry) => entry.id === project.id)?.repositoryIdentity
      return { hostId: 'local', hostName: 'This PC', projectId: project.id, name: project.name,
        checkoutLabel: project.path, local: true,
        repository: identity ? { canonicalKey: identity.canonicalKey,
          originKey: identity.origin?.canonicalKey, label: identity.origin?.displayName } : null }
    })
    for (const machine of machines) for (const project of inventories.get(machine.id)?.projects ?? []) {
      const identity = project.repositoryIdentity
      checkouts.push({ hostId: machine.id, hostName: machine.name, projectId: project.id,
        name: project.name, checkoutLabel: `${project.name} · ${project.id}`, local: false,
        repository: identity ? { canonicalKey: identity.canonicalKey,
          originKey: identity.origin?.canonicalKey, label: identity.origin?.displayName } : null })
    }
    const groups = groupRepositories(checkouts)
    const groupByCheckout = new Map(groups.flatMap((group) => group.checkouts.map((checkout) => [
      JSON.stringify([checkout.hostId, checkout.projectId]), group.id,
    ] as const)))
    const scopes = new Map<string, SessionScope>()
    const hosts = new Map<string, { name: string; status: string; readOnly: boolean }>()
    const project = (summary: SessionSummary, hostId: string): SessionSummary => {
      const machine = machines.find((item) => item.id === hostId)
      const scope: SessionScope = hostId === 'local' ? { kind: 'local', sessionId: summary.id } :
        { kind: 'remote', machineId: hostId, sessionId: summary.id }
      const key = sessionViewKey(scope)
      scopes.set(key, scope)
      hosts.set(key, { name: machine?.name ?? 'This PC', status: machine?.status ?? 'connected',
        readOnly: scope.kind === 'remote' && machine?.status !== 'connected' })
      const groupId = groupByCheckout.get(JSON.stringify([hostId, summary.projectId])) ??
        (scope.kind === 'local' ? summary.projectId : `checkout:${JSON.stringify([hostId, summary.projectId])}`)
      return projectSessionSummary(summary, (id) => sessionViewKey(scope.kind === 'local' ?
        { kind: 'local', sessionId: id } : { ...scope, sessionId: id }), groupId)
    }
    const sessions = localSessions.map((summary) => project(summary, 'local'))
    for (const machine of machines) sessions.push(...(inventories.get(machine.id)?.sessions ?? []).map((summary) => project(summary, machine.id)))
    const sidebarProjects = groups.filter((group) => group.checkouts.some((checkout) =>
      !checkout.local || projects.some((item) => item.id === checkout.projectId && item.open),
    )).map((group) => {
      const localCheckout = group.checkouts.find((checkout) => checkout.local)
      const localProject = projects.find((item) => item.id === localCheckout?.projectId)
      return { id: group.id, name: group.label ? `${group.name} · ${group.label}` : group.name,
        path: localProject?.path, status: localProject?.status,
        hostLabel: localCheckout ? undefined : [...new Set(group.checkouts.map((checkout) => checkout.hostName))].join(', '),
        localProjectId: localProject?.id,
        localActions: group.checkouts.filter((checkout) => checkout.local).length === 1,
      }
    })
    return { groups, sessions, scopes, hosts, sidebarProjects }
  }, [projects, localSessions, machines, local, inventories])
}
