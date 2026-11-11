import { machineEventsParamsSchema, type MachineOperationResult } from '@ari/contracts/machines'
import { RemoteError } from '@ari/remote-client'
import { remoteErrorCodeSchema } from '@ari/contracts/remote'
import type { RpcRegistry, ParsedParams } from './rpc-registry'
import type { MachinesService } from './machines'

/** No Engine access: all renderer machine calls enter the remote allowlist. */
export function registerMachinesRpc(registry: RpcRegistry, machines: MachinesService): void {
  registry.register('machines.list', () => machines.list())
  registry.register('machines.discover', () => machines.discover())
  registry.register('machines.add', (params) => machines.add(params.address, params.name))
  registry.register('machines.pair', (params) => machines.pair(params))
  registry.register('machines.pairStatus', (params) => machines.pairStatus(params.machineId))
  registry.register('machines.connect', (params) => machines.connect(params.machineId))
  registry.register('machines.rename', (params) => machines.rename(params.machineId, params.name))
  registry.register('machines.remove', (params) => machines.remove(params.machineId))
  registry.register('machines.query', (params) => operationResult(() => machines.query(params.machineId, params.query)))
  registry.register('machines.command', (params) => operationResult(() => machines.command(params.machineId, params.command)))
}

/** Electron serializes plain data but drops custom properties of thrown errors. */
async function operationResult(operation: () => Promise<unknown>): Promise<MachineOperationResult> {
  try { return { ok: true, result: await operation() } }
  catch (error) {
    if (error instanceof RemoteError) return { ok: false, error: { code: error.code, message: error.message } }
    // Unexpected failures provide no command outcome. Keep the ordinary IPC
    // rejection so clients retain their receipt and do not automatically retry.
    throw new Error('The computer request failed with an unknown outcome.')
  }
}

/** Validate scope before registering a renderer subscription, including late cleanup. */
export function subscribeMachineStream(registry: RpcRegistry, machines: MachinesService, params: ParsedParams<'stream.subscribe'>): void {
  if (params.name === 'machines.events') {
    const scope = machineEventsParamsSchema.parse(params.params)
    const subscriber = { id: params.id, name: params.name, params: scope }
    registry.subscribe(subscriber)
    void machines.subscribe(params.id, scope, (frame) => {
      if (registry.isCurrentSubscription(subscriber)) registry.sendTo(params.id, frame)
    }).catch((error: unknown) => {
      if (!registry.isCurrentSubscription(subscriber)) return
      const named = error instanceof RemoteError ? remoteErrorCodeSchema.safeParse(error.code) : null
      registry.sendTo(params.id, { machineId: scope.machineId, message: { type: 'error', error: {
        code: named?.success === true ? named.data : 'internal_error',
        message: error instanceof RemoteError ? error.message : 'The computer stream could not be opened. Reconnect this computer to resume.',
      } } })
    })
  } else if (params.name === 'machines.updates') {
    registry.subscribe({ id: params.id, name: params.name, params: {} })
    registry.sendTo(params.id, machines.list())
  }
}
