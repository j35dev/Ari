import { useCallback, useMemo, useRef } from 'react'
import type { Project } from '@ari/contracts/project'
import { remoteModelCatalogSchema, type RemoteModelCatalog, type RemoteHostResources } from '@ari/contracts/remote'
import type { SessionDefaults } from '../../App'
import { rpc } from '../../lib/rpc'
import { useMachines } from './use-machines'
import { ProjectDraft, type ProjectDraftClient } from './ProjectDraft'
import { localProjectDraftClient, remoteProjectDraftClient } from './project-draft-adapter'
import type { ProjectDraftEntry } from './project-draft-registry'
import type { ComposerSeed } from '../composer/Composer'
import type { SessionScope } from '../session/session-client'
import type { SelectionHost } from './machine-policy'

const usable = (catalog: RemoteModelCatalog | null) => catalog?.providers.some((provider) =>
  provider.available !== false && provider.installed !== false && provider.authStatus !== 'unauthenticated' && provider.models.length > 0,
) === true
const resource = (sample: RemoteHostResources | null): SelectionHost['resources'] => sample ? {
  sampledAt: sample.sampledAt ?? 0, available: sample.status === 'available', cpuUtilization: sample.cpuUtilization,
  availableMemoryBytes: sample.availableMemoryBytes, totalMemoryBytes: sample.totalMemoryBytes,
} : null

export function ProjectDraftPane({ entry, projects, defaults, createLocal, onCreated, onClose }: {
  entry: ProjectDraftEntry
  projects: Project[]
  defaults: SessionDefaults
  createLocal: (projectId: string, defaults: Partial<SessionDefaults>) => Promise<string>
  onCreated: (scope: SessionScope, seed?: ComposerSeed) => void
  onClose: () => void
}) {
  const metadata = useMachines()
  const latest = useRef({ metadata, projects, defaults, createLocal })
  latest.current = { metadata, projects, defaults, createLocal }
  const clients = useMemo(() => new Map<string, ProjectDraftClient>(), [entry.id])
  const clientFor = useCallback((hostId: string) => {
    const previous = clients.get(hostId)
    if (previous) return previous
    const client = hostId === 'local' ? localProjectDraftClient({
      catalog: async () => {
        // Same safe host catalog reader. Remote drafts never mount local probes.
        const snapshot = await rpc.invoke('machines.localSnapshot')
        const catalog = remoteModelCatalogSchema.parse((snapshot as { models?: unknown }).models)
        void latest.current.metadata.refreshInventory()
        return catalog
      },
      create: (projectId, pick, workspaceMode) => latest.current.createLocal(projectId, {
        ...pick, workspaceMode, ...(entry.lead ? { lead: true } : {}),
      }),
    }) : remoteProjectDraftClient(hostId, entry.id)
    clients.set(hostId, client)
    return client
  }, [clients, entry.id, entry.lead])
  const defaultFor = useCallback((hostId: string, projectId: string) => hostId === 'local'
    ? latest.current.projects.find((project) => project.id === projectId)?.defaultAgent ?? latest.current.defaults
    : latest.current.metadata.inventories.get(hostId)?.projects.find((project) => project.id === projectId)?.defaultAgent ?? null,
  [])
  const hosts = useMemo<SelectionHost[]>(() => [
    { id: 'local', name: 'This PC', connected: true, compatible: true,
      hasProject: entry.group.checkouts.some((checkout) => checkout.local && projects.some((project) => project.id === checkout.projectId && project.status !== 'missing')),
      usableCatalog: usable(metadata.localModels), preference: metadata.preferences.hostTiers.local ?? 'normal',
      resources: resource(metadata.local?.resources ?? null) },
    ...metadata.machines.map((machine) => {
      const inventory = metadata.inventories.get(machine.id)
      return { id: machine.id, name: machine.name, connected: machine.status === 'connected',
        compatible: machine.versionReady !== false && machine.identity?.machinesExtensions?.operations.includes('session.desktop.create') === true,
        hasProject: entry.group.checkouts.some((checkout) => checkout.hostId === machine.id &&
          inventory?.projects.some((project) => project.id === checkout.projectId && project.status !== 'missing')),
        usableCatalog: inventory?.permissions !== null && inventory?.permissions !== undefined && usable(inventory?.catalog ?? null),
        preference: metadata.preferences.hostTiers[machine.id] ?? 'normal', resources: resource(inventory?.resources ?? null),
      }
    }),
  ].filter((host) => !entry.lead || host.id === 'local'), [entry.group, entry.lead, projects, metadata])
  return <ProjectDraft draftId={entry.id} group={entry.group} hosts={hosts} initialHostId={entry.initialHostId}
    autoEnabled={metadata.preferences.autoEnabled} lastManualHostId={metadata.preferences.projectHosts[entry.groupId]}
    clientFor={clientFor} defaultFor={defaultFor} onCreated={onCreated} onClose={onClose}
    onRememberHost={(hostId) => { void rpc.invoke('machines.rememberProjectHost', { projectKey: entry.groupId, machineId: hostId })
      .then(() => metadata.refreshInventory()).catch(() => undefined) }} />
}
