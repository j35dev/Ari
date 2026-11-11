import { z } from 'zod'
import {
  remoteCommandEnvelopeSchema,
  remoteErrorSchema,
  remoteQuerySchema,
  type RemoteCommand,
  type RemoteQuery,
} from '@ari/contracts/remote'
import { rpc } from '../../lib/rpc'

type WithoutEnvelope<T> = T extends RemoteCommand
  ? Omit<T, 'clientCommandId' | 'idempotencyKey'>
  : never
export type RemoteAction = WithoutEnvelope<RemoteCommand>

const receiptSchema = z.object({
  machineId: z.string(),
  scope: z.string(),
  command: remoteCommandEnvelopeSchema,
})
export type RemoteReceipt = z.infer<typeof receiptSchema>

export function scopeKey(machineId: string, sessionId: string): string {
  return JSON.stringify([machineId, sessionId])
}
const receiptKey = (machineId: string, scope: string) =>
  `ari.machines.receipt.v1:${scopeKey(machineId, scope)}`

export function readReceipt(machineId: string, scope: string): RemoteReceipt | null {
  const raw = localStorage.getItem(receiptKey(machineId, scope))
  if (raw === null) return null
  try {
    const receipt = receiptSchema.parse(JSON.parse(raw))
    return receipt.machineId === machineId && receipt.scope === scope ? receipt : null
  } catch {
    throw new Error('This submission receipt cannot be read. Inspect the host before sending again.')
  }
}

function clearReceipt(machineId: string, scope: string): void {
  localStorage.removeItem(receiptKey(machineId, scope))
}

/** Only allowlisted machine RPCs cross this boundary. No local fallback exists. */
export async function remoteQuery(machineId: string, query: RemoteQuery): Promise<unknown> {
  return resultOf(await rpc.invoke('machines.query', {
    machineId,
    query: remoteQuerySchema.parse(query),
  }))
}

/** Gateway mutations may retain their wire envelope; queries are normally unwrapped. */
export function resultOf(raw: unknown): unknown {
  const envelope = z.object({ ok: z.boolean(), result: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string() }).optional() }).safeParse(raw)
  if (!envelope.success) return raw
  if (!envelope.data.ok) throw Object.assign(new Error(envelope.data.error?.message ?? 'Host refused the request.'), envelope.data.error)
  return resultOf(envelope.data.result)
}

/** Persist the exact command before IPC, and never automatically repeat a mutation. */
export async function sendRemote(machineId: string, scope: string, action: RemoteAction): Promise<unknown> {
  if (readReceipt(machineId, scope) !== null) throw new Error('Check the unconfirmed submission before sending another action.')
  const key = crypto.randomUUID()
  const command = remoteCommandEnvelopeSchema.parse({ ...action, clientCommandId: key, idempotencyKey: key })
  const receipt: RemoteReceipt = { machineId, scope, command }
  try {
    localStorage.setItem(receiptKey(machineId, scope), JSON.stringify(receipt))
  } catch {
    throw new Error('The submission receipt could not be saved. Free browser storage before sending.')
  }
  return submitReceipt(receipt)
}

async function submitReceipt(receipt: RemoteReceipt): Promise<unknown> {
  try {
    const result = resultOf(await rpc.invoke('machines.command', {
      machineId: receipt.machineId,
      command: receipt.command,
    }))
    clearReceipt(receipt.machineId, receipt.scope)
    return result
  } catch (error) {
    // A named host refusal is definitive. Transport/IPC errors retain the key.
    if (remoteErrorSchema.safeParse(error).success) clearReceipt(receipt.machineId, receipt.scope)
    throw error
  }
}

/** A user-requested retry first checks the originating host's recorded outcome. */
export async function resolveReceipt(machineId: string, scope: string, retry = false): Promise<unknown> {
  const receipt = readReceipt(machineId, scope)
  if (receipt === null) throw new Error('No unconfirmed submission exists.')
  try {
    const result = await remoteQuery(machineId, { op: 'command.status', idempotencyKey: receipt.command.idempotencyKey })
    clearReceipt(machineId, scope)
    return result
  } catch (error) {
    if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'not_found')) throw error
    if (retry) return submitReceipt(receipt)
    throw new Error('The host has no receipt for this action. You can explicitly retry the saved action.')
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The host could not complete this request.'
}
