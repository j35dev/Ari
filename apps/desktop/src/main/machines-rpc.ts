import { machineEventsParamsSchema } from '@ari/contracts/machines'
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
  registry.register('machines.query', (params) => machines.query(params.machineId, params.query))
  registry.register('machines.command', (params) => machines.command(params.machineId, params.command))
}

/** Validate scope before registering a renderer subscription, including late cleanup. */
export function subscribeMachineStream(registry: RpcRegistry, machines: MachinesService, params: ParsedParams<'stream.subscribe'>): void {
  if (params.name === 'machines.events') {
    const scope = machineEventsParamsSchema.parse(params.params)
    registry.subscribe({ id: params.id, name: params.name, params: scope })
    void machines.subscribe(params.id, scope, (frame) => registry.sendTo(params.id, frame)).catch(() => {
      registry.sendTo(params.id, { machineId: scope.machineId, message: { type: 'error', error: { code: 'internal_error', message: 'The computer stream could not be opened. Reconnect this computer to resume.' } } })
    })
  } else if (params.name === 'machines.updates') {
    registry.subscribe({ id: params.id, name: params.name, params: {} })
    registry.sendTo(params.id, machines.list())
  }
}
