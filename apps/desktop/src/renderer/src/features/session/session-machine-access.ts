import { z } from 'zod'
import { machineViewSchema, type MachineView } from '@ari/contracts/machines'
import { machinesExtensionsSchema, machinesExtensionOperationSchema } from '@ari/contracts/remote'
import { rpc } from '../../lib/rpc'
import { invalidateMachineSessionCaches } from './session-scope'

const inventorySchema = machineViewSchema.extend({
  identity: machineViewSchema.shape.identity.unwrap().extend({
    machinesExtensions: machinesExtensionsSchema.optional(),
  }).nullable(),
})
export type SessionMachine = z.infer<typeof inventorySchema>
const machines = new Map<string, SessionMachine>()
const epochs = new Map<string, number>()
const listeners = new Set<() => void>()
let revision = 0
let request = 0
let stop: (() => void) | null = null

export function machineEpoch(machineId: string): number { return epochs.get(machineId) ?? 0 }
export function sessionMachine(machineId: string): SessionMachine | null { return machines.get(machineId) ?? null }
export function machineInventoryRevision(): number { return revision }
export function observeMachineInventory(callback: () => void): () => void {
  listeners.add(callback)
  if (stop === null) {
    stop = rpc.subscribe('machines.updates', {}, (raw) => {
      const parsed = inventorySchema.array().safeParse(raw)
      if (parsed.success) { request++; adopt(parsed.data) }
    })
    void refreshMachineInventory().catch(() => undefined)
  }
  return () => {
    listeners.delete(callback)
    if (listeners.size === 0) { stop?.(); stop = null }
  }
}

function adopt(next: SessionMachine[]): void {
  const ids = new Set(next.map((machine) => machine.id))
  for (const [id, previous] of machines) {
    const replacement = next.find((machine) => machine.id === id)
    const revoked = !replacement || ['revoked', 'unpaired'].includes(replacement.status) ||
      (previous.identity?.machineId && replacement.identity?.machineId &&
        previous.identity.machineId !== replacement.identity.machineId)
    if (revoked && (!replacement || previous.status !== replacement.status ||
      previous.identity?.machineId !== replacement.identity?.machineId)) {
      epochs.set(id, machineEpoch(id) + 1)
      invalidateMachineSessionCaches(id)
    }
    if (!ids.has(id)) machines.delete(id)
  }
  for (const machine of next) machines.set(machine.id, machine)
  revision++
  for (const listener of listeners) listener()
}

export async function refreshMachineInventory(): Promise<void> {
  const started = ++request
  const next = inventorySchema.array().parse(await rpc.invoke('machines.list'))
  if (started === request) adopt(next)
}

export function machineCapabilityReason(machine: SessionMachine | MachineView | null, operation: string): string | null {
  if (!machine) return 'This machine is unavailable or was removed.'
  if (machine.status !== 'connected') return machine.error ??
    (machine.status === 'incompatible' ? 'This host version is incompatible. Cached content is read-only.' :
      machine.status === 'revoked' ? 'Access to this machine was revoked.' : 'Reconnect to this machine to continue.')
  const extension = machinesExtensionOperationSchema.safeParse(operation)
  if (extension.success) {
    const identity = machine.identity as SessionMachine['identity']
    return identity?.machinesExtensions?.version === 1 &&
      identity.machinesExtensions.operations.includes(extension.data) ? null :
      'This host does not support this desktop operation. Update the host to enable it.'
  }
  return machine.identity?.capabilities.includes(operation) ? null : 'This action is unavailable on this machine.'
}

/** Public capability data only gates presentation; main/host still enforce the effective grant. */
export async function assertMachineOperation(machineId: string, operation: string): Promise<number> {
  await refreshMachineInventory()
  const reason = machineCapabilityReason(sessionMachine(machineId), operation)
  if (reason) throw new Error(reason)
  return machineEpoch(machineId)
}
