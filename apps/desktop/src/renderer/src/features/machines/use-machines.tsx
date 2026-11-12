import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { machineViewSchema, type MachineView } from '@ari/contracts/machines'
import { machinesPreferencesSchema, type MachinesPreferences } from '@ari/contracts/machines'
import {
  machinesLocalSnapshotSchema, remoteProjectCatalogSchema, remoteModelCatalogSchema,
  remoteHostResourcesSchema, remoteHostPermissionsSchema, remoteHostVersionSchema,
  remoteProjectSchema, type MachinesLocalSnapshot, type RemoteProjectCatalogEntry,
  type RemoteModelCatalog, type RemoteHostResources, type RemoteHostPermissions, type RemoteHostVersion,
} from '@ari/contracts/remote'
import { sessionSummarySchema, type SessionSummary } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { messageOf, remoteQuery } from './remote-client'
import { queryMachineMetadata } from './machine-inventory'

export interface MachineInventory {
  identityMachineId?: string
  projects: RemoteProjectCatalogEntry[]
  sessions: SessionSummary[]
  catalog: RemoteModelCatalog | null
  permissions: RemoteHostPermissions | null
  version: RemoteHostVersion | null
  error: string | null
}
const emptyInventory: MachineInventory = { projects: [], sessions: [], catalog: null,
  permissions: null, version: null, error: null }

interface MachinesState {
  machines: MachineView[]
  error: string | null
  refresh: () => Promise<void>
  local: MachinesLocalSnapshot | null
  localModels: RemoteModelCatalog | null
  inventories: ReadonlyMap<string, MachineInventory>
  inventoryReady: boolean
  resources: ReadonlyMap<string, RemoteHostResources | null>
  /** Authenticated demand only: explicit Auto setup/reselection and pre-Send validation. */
  refreshResources: (hostIds: readonly string[]) => Promise<ReadonlyMap<string, RemoteHostResources | null>>
  preferences: MachinesPreferences
  refreshInventory: () => Promise<void>
}
const Context = createContext<MachinesState>({
  machines: [],
  error: null,
  refresh: () => Promise.resolve(),
  local: null, localModels: null, inventories: new Map(),
  inventoryReady: false,
  resources: new Map(), refreshResources: () => Promise.resolve(new Map()),
  preferences: { autoEnabled: false, hostTiers: {}, projectHosts: {} },
  refreshInventory: () => Promise.resolve(),
})

export function MachinesProvider({ children }: { children: ReactNode }) {
  const [machines, setMachines] = useState<MachineView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<MachinesLocalSnapshot | null>(null)
  const [localModels, setLocalModels] = useState<RemoteModelCatalog | null>(null)
  const [inventories, setInventories] = useState<ReadonlyMap<string, MachineInventory>>(new Map())
  const [inventoryReady, setInventoryReady] = useState(false)
  const [resources, setResources] = useState<ReadonlyMap<string, RemoteHostResources | null>>(new Map())
  const resourceGenerations = useRef(new Map<string, number>())
  const [preferences, setPreferences] = useState<MachinesPreferences>({ autoEnabled: false, hostTiers: {}, projectHosts: {} })
  const machinesRef = useRef(machines)
  machinesRef.current = machines
  const inventoryRevision = useRef(0)
  const revision = useRef(0)
  const alive = useRef(true)
  const acceptMachines = useCallback((next: MachineView[]) => {
    for (const previous of machinesRef.current) {
      const current = next.find((machine) => machine.id === previous.id)
      if (current?.status !== 'connected' || previous.status !== 'connected' ||
        current.identity?.machineId !== previous.identity?.machineId) {
        resourceGenerations.current.set(previous.id, (resourceGenerations.current.get(previous.id) ?? 0) + 1)
        setResources((old) => { const kept = new Map(old); kept.delete(previous.id); return kept })
      }
    }
    inventoryRevision.current++
    machinesRef.current = next
    setMachines(next)
    setInventories((old) => new Map([...old].filter(([id, inventory]) => {
      const machine = next.find((item) => item.id === id)
      return machine && !['revoked', 'unpaired'].includes(machine.status) &&
        inventory.identityMachineId === machine.identity?.machineId
    })))
  }, [])
  const refresh = useCallback(async () => {
    const started = ++revision.current
    try {
      const next = machineViewSchema.array().parse(await rpc.invoke('machines.list'))
      if (!alive.current || revision.current !== started) return
      acceptMachines(next)
      setError(null)
    } catch (error) {
      if (alive.current && revision.current === started) setError(messageOf(error))
    }
  }, [acceptMachines])
  const refreshInventory = useCallback(async () => {
    const generation = ++inventoryRevision.current
    const currentMachines = machinesRef.current
    const results = await Promise.allSettled([
      rpc.invoke('machines.localSnapshot').then((raw) => {
        if (alive.current && inventoryRevision.current === generation) {
          setLocal(machinesLocalSnapshotSchema.parse(raw))
          const models = remoteModelCatalogSchema.safeParse((raw as { models?: unknown }).models)
          setLocalModels(models.success ? models.data : null)
        }
      }),
      rpc.invoke('machines.preferences').then((raw) => {
        if (alive.current && inventoryRevision.current === generation) setPreferences(machinesPreferencesSchema.parse(raw))
      }),
      ...currentMachines.filter((machine) => machine.status === 'connected').map(async (machine) => {
        try {
          const desktop = machine.identity?.machinesExtensions?.operations.includes('project.catalog') === true
          const [projectRaw, sessionsRaw, catalogRaw, permissionsRaw, versionRaw] = await Promise.all([
            desktop ? queryMachineMetadata(machine.id, { op: 'project.catalog' }) : remoteQuery(machine.id, { op: 'project.list' }),
            remoteQuery(machine.id, { op: 'session.list' }), remoteQuery(machine.id, { op: 'models.list' }),
            desktop ? queryMachineMetadata(machine.id, { op: 'host.permissions' }) : Promise.resolve(null),
            desktop ? queryMachineMetadata(machine.id, { op: 'host.version' }) : Promise.resolve(null),
          ])
          const next: MachineInventory = {
            identityMachineId: machine.identity?.machineId,
            projects: desktop ? remoteProjectCatalogSchema.parse(projectRaw).projects :
              remoteProjectSchema.array().parse(projectRaw).map((project) => ({ ...project, status: 'ok', defaultAgent: null, repositoryIdentity: null })),
            sessions: sessionSummarySchema.array().parse(sessionsRaw),
            catalog: remoteModelCatalogSchema.parse(catalogRaw),
            permissions: permissionsRaw ? remoteHostPermissionsSchema.parse(permissionsRaw) : null,
            version: versionRaw ? remoteHostVersionSchema.parse(versionRaw) : null, error: null,
          }
          if (!alive.current || inventoryRevision.current !== generation) return
          const current = machinesRef.current.find((item) => item.id === machine.id)
          if (current?.status !== 'connected' || current.identity?.machineId !== machine.identity?.machineId) return
          setInventories((old) => new Map(old).set(machine.id, next))
        } catch (error) {
          if (!alive.current || inventoryRevision.current !== generation) return
          const current = machinesRef.current.find((item) => item.id === machine.id)
          if (current?.status !== 'connected' || current.identity?.machineId !== machine.identity?.machineId) return
          setInventories((old) => new Map(old).set(machine.id, { ...old.get(machine.id) ?? emptyInventory,
            identityMachineId: machine.identity?.machineId, catalog: null, permissions: null, error: messageOf(error) }))
        }
      }),
    ])
    // Inventory carries no resource authorization or sampling side effect.
    if (results[0]?.status === 'rejected' && alive.current && inventoryRevision.current === generation) {
      setLocal(null); setLocalModels(null)
    }
    if (alive.current && inventoryRevision.current === generation) setInventoryReady(true)
  }, [])
  const refreshResources = useCallback(async (hostIds: readonly string[]) => {
    const sampled = new Map<string, RemoteHostResources | null>()
    await Promise.all([...new Set(hostIds)].map(async (id) => {
      const machine = machinesRef.current.find((item) => item.id === id)
      const generation = (resourceGenerations.current.get(id) ?? 0) + 1
      resourceGenerations.current.set(id, generation)
      const valid = () => alive.current && resourceGenerations.current.get(id) === generation &&
        (id === 'local' || machinesRef.current.some((current) => current.id === id && current.status === 'connected' &&
          current.identity?.machineId === machine?.identity?.machineId))
      let result: RemoteHostResources | null = null
      try {
        if (id === 'local') {
          const snapshot = machinesLocalSnapshotSchema.parse(await rpc.invoke('machines.localSnapshot', { sampleResources: true }))
          result = snapshot.resources
        } else if (machine?.status === 'connected' && machine.versionReady !== false &&
          machine.identity?.machinesExtensions?.operations.includes('host.resources')) {
          result = remoteHostResourcesSchema.parse(await queryMachineMetadata(id, { op: 'host.resources' }))
        }
      } catch { /* Missing/refused samples require manual selection, never stale reuse. */ }
      if (!valid()) { sampled.set(id, null); return }
      sampled.set(id, result)
      setResources((old) => new Map(old).set(id, result))
    }))
    return sampled
  }, [])
  const machineGeneration = machines.map((machine) => `${machine.id}:${machine.status}:${machine.identity?.machineId ?? ''}`).join('|')
  useEffect(() => {
    setInventoryReady(false)
    const allowed = new Set(machines.filter((machine) => !['revoked', 'unpaired'].includes(machine.status)).map((machine) => machine.id))
    setInventories((old) => new Map([...old].filter(([id]) => allowed.has(id))))
    void refreshInventory()
    const timer = setInterval(() => void refreshInventory(), 10_000)
    return () => { inventoryRevision.current++; clearInterval(timer) }
  }, [machineGeneration, refreshInventory])
  useEffect(() => {
    alive.current = true
    const unsubscribe = rpc.subscribe('machines.updates', {}, (raw) => {
      const parsed = machineViewSchema.array().safeParse(raw)
      if (alive.current && parsed.success) {
        revision.current++
        acceptMachines(parsed.data)
      }
    })
    void refresh()
    const timer = setInterval(() => void refresh(), 15_000)
    return () => {
      alive.current = false
      unsubscribe()
      clearInterval(timer)
    }
  }, [refresh, acceptMachines])
  return <Context.Provider value={{ machines, error, refresh, local, localModels, inventories, inventoryReady, resources, refreshResources, preferences, refreshInventory }}>{children}</Context.Provider>
}

export const useMachines = () => useContext(Context)
export const useMachineInventory = (machine: MachineView) => useMachines().inventories.get(machine.id) ?? emptyInventory

export function machineCan(machine: MachineView, op: string): boolean {
  return machine.status === 'connected' && machine.identity?.capabilities.includes(op) === true
}
