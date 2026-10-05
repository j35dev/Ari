import { createHash } from 'node:crypto'
import type { AgentControlService } from '@ari/engine/agent-control'
import { remoteForkNativeResultSchema, type RemoteCommand } from '@ari/contracts/remote'
import type { DriverKind } from '@ari/contracts/common'

export type RemoteForkCommand = Extract<RemoteCommand, { op: 'session.fork' }>
export type RemoteForkResult =
  { ok: true; result: { sessionId: string } } | { ok: false; code: string; message: string }

/** Uses native delegation policy and approvals with an immutable isolated workspace mode. */
export async function forkRemoteSession(
  service: Pick<AgentControlService, 'invoke'>,
  deviceId: string,
  command: RemoteForkCommand & { driverKind: DriverKind; modelId?: string },
): Promise<RemoteForkResult> {
  const result = await service.invoke(command.sessionId, 'session.spawn', {
    title: command.title,
    driverKind: command.driverKind,
    modelId: command.modelId ?? null,
    workspaceMode: 'isolated',
    idempotencyKey: createHash('sha256')
      .update(JSON.stringify([deviceId, command.idempotencyKey]))
      .digest('hex'),
  })
  if (!result.ok) return { ok: false, code: 'conflict', message: result.error.message }
  const parsed = remoteForkNativeResultSchema.safeParse(result.result)
  return parsed.success
    ? { ok: true, result: { sessionId: parsed.data.child.id } }
    : {
        ok: false,
        code: 'internal_error',
        message: 'The child session could not be confirmed. Inspect the parent before retrying.',
      }
}
