import { remoteDesktopQuerySchema, type RemoteDesktopQuery } from '@ari/contracts/remote'
import { machineOperationResultSchema } from '@ari/contracts/machines'
import { rpc } from '../../lib/rpc'
import { resultOf } from './remote-client'

/** A bounded read-only desktop extension; never a generic host RPC tunnel. */
export async function queryMachineMetadata(machineId: string, query: RemoteDesktopQuery): Promise<unknown> {
  return resultOf(machineOperationResultSchema.parse(await rpc.invoke('machines.query', {
    machineId, query: remoteDesktopQuerySchema.parse(query),
  })))
}
