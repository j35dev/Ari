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
  projects: RemoteProjectCatalogEntry[]
  sessions: SessionSummary[]
  catalog: RemoteModelCatalog | null
  resources: RemoteHostResources | null
  permissions: RemoteHostPermissions | null
  version: RemoteHostVersion | null
  error: string | null
}
const emptyInventory: MachineInventory = { projects: [], sessions: [], catalog: null,
  resources: null, permissions: null, version: null, error: null }

interface MachinesState {
  machines: MachineView[]
  error: string | null
  refresh: () => Promise<void>
  local: MachinesLocalSnapshot | null
  localModels: RemoteModelCatalog | null
  inventories: ReadonlyMap<string, MachineInventory>
  preferences: MachinesPreferences
  refreshInventory: () => Promise<void>
}
const Context = createContext<MachinesState>({
  machines: [],
  error: null,
  refresh: () => Promise.resolve(),
  local: null, localModels: null, inventories: new Map(),
  preferences: { autoEnabled: false, hostTiers: {}, projectHosts: {} },
  refreshInventory: () => Promise.resolve(),
})

export function MachinesProvider({ children }: { children: ReactNode }) {
  const [machines, setMachines] = useState<MachineView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<MachinesLocalSnapshot | null>(null)
  const [localModels, setLocalModels] = useState<RemoteModelCatalog | null>(null)
  const [inventories, setInventories] = useState<ReadonlyMap<string, MachineInventory>>(new Map())
  const [preferences, setPreferences] = useState<MachinesPreferences>({ autoEnabled: false, hostTiers: {}, projectHosts: {} })
  const machinesRef = useRef(machines)
  machinesRef.current = machines
  const inventoryRevision = useRef(0)
  const revision = useRef(0)
  const alive = useRef(true)
  const refresh = useCallback(async () => {
    const started = ++revision.current
    try {
      const next = machineViewSchema.array().parse(await rpc.invoke('machines.list'))
      if (!alive.current || revision.current !== started) return
      setMachines(next)
      setError(null)
    } catch (error) {
      if (alive.current && revision.current === started) setError(messageOf(error))
    }
  }, [])
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
          const [projectRaw, sessionsRaw, catalogRaw, resourcesRaw, permissionsRaw, versionRaw] = await Promise.all([
            desktop ? queryMachineMetadata(machine.id, { op: 'project.catalog' }) : remoteQuery(machine.id, { op: 'project.list' }),
            remoteQuery(machine.id, { op: 'session.list' }), remoteQuery(machine.id, { op: 'models.list' }),
            desktop ? queryMachineMetadata(machine.id, { op: 'host.resources' }) : Promise.resolve(null),
            desktop ? queryMachineMetadata(machine.id, { op: 'host.permissions' }) : Promise.resolve(null),
            desktop ? queryMachineMetadata(machine.id, { op: 'host.version' }) : Promise.resolve(null),
          ])
          const next: MachineInventory = {
            projects: desktop ? remoteProjectCatalogSchema.parse(projectRaw).projects :
              remoteProjectSchema.array().parse(projectRaw).map((project) => ({ ...project, status: 'ok', defaultAgent: null, repositoryIdentity: null })),
            sessions: sessionSummarySchema.array().parse(sessionsRaw),
            catalog: remoteModelCatalogSchema.parse(catalogRaw),
            resources: resourcesRaw ? remoteHostResourcesSchema.parse(resourcesRaw) : null,
            permissions: permissionsRaw ? remoteHostPermissionsSchema.parse(permissionsRaw) : null,
            version: versionRaw ? remoteHostVersionSchema.parse(versionRaw) : null, error: null,
          }
          if (!alive.current || inventoryRevision.current !== generation) return
          const current = machinesRef.current.find((item) => item.id === machine.id)
          if (current?.status !== 'connected' || current.identity?.machineId !== machine.identity?.machineId) return
          setInventories((old) => new Map(old).set(machine.id, next))
        } catch (error) {
          if (!alive.current || inventoryRevision.current !== generation) return
          setInventories((old) => new Map(old).set(machine.id, { ...old.get(machine.id) ?? emptyInventory, resources: null, error: messageOf(error) }))
        }
      }),
    ])
    // A failed local sample can never keep Auto eligible using an older sample.
    if (results[0]?.status === 'rejected' && alive.current && inventoryRevision.current === generation) setLocal(null)
  }, [])
  const machineGeneration = machines.map((machine) => `${machine.id}:${machine.status}:${machine.identity?.machineId ?? ''}`).join('|')
  useEffect(() => {
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
        setMachines(parsed.data)
      }
    })
    void refresh()
    const timer = setInterval(() => void refresh(), 15_000)
    return () => {
      alive.current = false
      unsubscribe()
      clearInterval(timer)
    }
  }, [refresh])
  return <Context.Provider value={{ machines, error, refresh, local, localModels, inventories, preferences, refreshInventory }}>{children}</Context.Provider>
}

export const useMachines = () => useContext(Context)
export const useMachineInventory = (machine: MachineView) => useMachines().inventories.get(machine.id) ?? emptyInventory

export function machineCan(machine: MachineView, op: string): boolean {
  return machine.status === 'connected' && machine.identity?.capabilities.includes(op) === true
}
