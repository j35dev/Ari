import { z } from 'zod'
import {
  remoteCommandEnvelopeSchema,
  remoteQuerySchema,
  remoteAccountsSchema,
  remoteRedeemSchema,
  type RemoteCommand,
  type RemoteQuery,
} from '@ari/contracts/remote'
import { rpc } from '../../lib/rpc'
import { machineOperationResultSchema } from '@ari/contracts/machines'
import { attachmentRefSchema } from '@ari/contracts/attachments'

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
const PRE_DISPATCH_REFUSALS = new Set([
  'unauthenticated',
  'authentication_expired',
  'access_revoked',
  'origin_not_allowed',
  'unsupported_version',
  'unsupported_capability',
  'rate_limited',
  'invalid_signature',
  'invitation_expired',
  'invitation_used',
  'pairing_denied',
])
class RefusedCommand extends Error {}

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
    if (receipt.machineId !== machineId || receipt.scope !== scope)
      throw new Error('Wrong receipt scope')
    assertScope(scope, receipt.command)
    return receipt
  } catch {
    throw new Error(
      'This submission receipt cannot be read. Inspect the host before sending again.',
    )
  }
}

function clearReceipt(machineId: string, scope: string): void {
  localStorage.removeItem(receiptKey(machineId, scope))
}

/** Only allowlisted machine RPCs cross this boundary. No local fallback exists. */
export async function remoteQuery(machineId: string, query: RemoteQuery): Promise<unknown> {
  return resultOf(
    machineOperationResultSchema.parse(
      await rpc.invoke('machines.query', {
        machineId,
        query: remoteQuerySchema.parse(query),
      }),
    ),
  )
}

/** Gateway mutations may retain their wire envelope; queries are normally unwrapped. */
export function resultOf(raw: unknown): unknown {
  const envelope = z
    .object({
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    })
    .safeParse(raw)
  if (!envelope.success) return raw
  if (!envelope.data.ok)
    throw Object.assign(
      new Error(envelope.data.error?.message ?? 'Host refused the request.'),
      envelope.data.error,
    )
  return resultOf(envelope.data.result)
}

/** Persist the exact command before IPC, and never automatically repeat a mutation. */
export async function sendRemote(
  machineId: string,
  scope: string,
  action: RemoteAction,
): Promise<unknown> {
  assertScope(scope, action)
  if (readReceipt(machineId, scope) !== null)
    throw new Error('Check the unconfirmed submission before sending another action.')
  const key = crypto.randomUUID()
  const command = remoteCommandEnvelopeSchema.parse({
    ...action,
    clientCommandId: key,
    idempotencyKey: key,
  })
  const receipt: RemoteReceipt = { machineId, scope, command }
  try {
    localStorage.setItem(receiptKey(machineId, scope), JSON.stringify(receipt))
  } catch {
    throw new Error(
      'The submission receipt could not be saved. Free browser storage before sending.',
    )
  }
  return submitReceipt(receipt)
}

async function submitReceipt(receipt: RemoteReceipt): Promise<unknown> {
  try {
    const result = resultOf(
      machineOperationResultSchema.parse(
        await rpc.invoke('machines.command', {
          machineId: receipt.machineId,
          command: receipt.command,
        }),
      ),
    )
    validateCommandResult(receipt.command, result)
    clearReceipt(receipt.machineId, receipt.scope)
    return result
  } catch (error) {
    // Execution/persistence failures and in-flight conflicts can follow a side effect.
    // Only a gateway guard refusal or an explicit accepted:false result proves non-dispatch.
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null
    if (
      error instanceof RefusedCommand ||
      (typeof code === 'string' && PRE_DISPATCH_REFUSALS.has(code))
    )
      clearReceipt(receipt.machineId, receipt.scope)
    throw error
  }
}

function assertScope(scope: string, action: RemoteAction): void {
  if ('sessionId' in action) {
    if (
      ![
        action.sessionId,
        `terminal:${action.sessionId}`,
        `terminal-close:${action.sessionId}`,
      ].includes(scope)
    )
      throw new Error('The command belongs to another session.')
  } else if (action.op === 'session.create' && scope !== 'new-session') {
    throw new Error('Session creation belongs to the selected host’s creation draft.')
  }
}

/** Saved actions are checked read-only. Absence never proves non-execution. */
export async function resolveReceipt(
  machineId: string,
  scope: string,
  // Retain call compatibility for old controls without permitting resubmission.
  _retry = false,
): Promise<unknown> {
  const receipt = readReceipt(machineId, scope)
  if (receipt === null) throw new Error('No unconfirmed submission exists.')
  try {
    const result = await remoteQuery(machineId, {
      op: 'command.status',
      idempotencyKey: receipt.command.idempotencyKey,
    })
    validateCommandResult(receipt.command, result)
    clearReceipt(machineId, scope)
    return result
  } catch (error) {
    if (error instanceof RefusedCommand) {
      clearReceipt(machineId, scope)
      throw error
    }
    if (!(
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'not_found'
    ))
      throw error
    throw new Error(
      'The host has no retained result for this action. Its outcome is unknown. Inspect the host before submitting again.',
      { cause: error },
    )
  }
}

function validateCommandResult(command: RemoteCommand, result: unknown): void {
  const decision = z
    .object({ accepted: z.boolean(), reason: z.string().nullish() })
    .safeParse(result)
  if (decision.success && !decision.data.accepted)
    throw new RefusedCommand(decision.data.reason ?? 'The host refused this command.')
  switch (command.op) {
    case 'session.create':
    case 'session.fork':
      z.object({ sessionId: z.string().min(1) }).parse(result)
      return
    case 'terminal.create':
      z.object({ terminalId: z.string().min(1) }).parse(result)
      return
    case 'terminal.kill':
      z.object({ killed: z.literal(true) }).parse(result)
      return
    case 'attachments.stage':
      z.object({ attachments: attachmentRefSchema.array() }).parse(result)
      return
    case 'accounts.activate':
      remoteAccountsSchema.parse(result)
      return
    case 'usage.redeem':
      remoteRedeemSchema.parse(result)
      return
    case 'changes.integrate':
      z.object({
        status: z.enum(['integrated', 'conflict', 'already_integrated']),
        snapshotCommit: z.literal(command.snapshotCommit),
      }).parse(result)
      return
    default:
      z.object({ accepted: z.literal(true) }).parse(result)
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The host could not complete this request.'
}
