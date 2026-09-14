import { z } from 'zod'
import { approvalOptionSchema, driverKindSchema, timestampSchema } from './common'

/**
 * The remote surface is an allowlist, not a filter.
 *
 * Everything a paired phone may do is named here; an operation with no schema
 * has no route, so the gateway cannot perform what was never declared. ADR §3
 * defers terminal and shell access, provider login, arbitrary filesystem
 * roots, API-key configuration and `fs.writeTextFile` — their absence below is
 * the enforcement. Adding one is a deliberate, reviewable act.
 */

/** Bumped only for changes a client of the previous version cannot survive. */
export const REMOTE_PROTOCOL_VERSION = 1

export const remoteOperationSchema = z.enum([
  // Discovery. Unauthenticated and content-free.
  'gateway.info',
  // Pairing, before a device holds any credential. Minting an invitation and
  // approving a device are deliberately absent: both are the user's acts, made
  // at the desktop. A remotely reachable `approve` would let whoever
  // photographed the QR code approve their own device, and the confirmation
  // code on screen would then be confirming nothing.
  'pairing.request',
  'pairing.status',
  'pairing.redeem',
  // A remembered device, proving its key again without re-pairing. Anonymous
  // because the proof *is* the credential: a phone that has been through one
  // pairing holds a key the desktop already approved, and signing a fresh
  // challenge is how it comes back after a restart or a cleared tab.
  'device.challenge',
  'device.authorize',
  // Sessions.
  'session.list',
  'session.get',
  'session.create',
  'session.archive',
  // Agent actions.
  'session.prompt',
  'session.queue',
  'session.steer',
  'session.interrupt',
  // Human input.
  'approval.respond',
  'input.respond',
  // Changes.
  'changes.files',
  'changes.diff',
  'changes.integrate',
  // Events.
  'events.snapshot',
  'events.subscribe',
  'events.ack',
  // Devices.
  'device.list',
  'device.revoke',
  // Idempotency outcome lookup.
  'command.status',
])
export type RemoteOperation = z.infer<typeof remoteOperationSchema>

export const REMOTE_OPERATIONS = remoteOperationSchema.options

/**
 * The operations a client may invoke without a device credential. Everything
 * else requires one, so a failure to authenticate cannot fall through to a
 * default-allow branch.
 *
 * These are the whole of the handshake a phone performs on its own: it learns
 * what protocol it is speaking, registers a key, watches for the user's
 * decision, trades a signature for a token, and — from then on — trades a
 * signature for a fresh one. The decisions themselves are not here: minting an
 * invitation and approving a device are the user's acts, made at the desktop.
 */
export const REMOTE_ANONYMOUS_OPERATIONS: readonly RemoteOperation[] = [
  'gateway.info',
  'pairing.request',
  'pairing.status',
  'pairing.redeem',
  'device.challenge',
  'device.authorize',
]

export function requiresAuthentication(operation: RemoteOperation): boolean {
  return !REMOTE_ANONYMOUS_OPERATIONS.includes(operation)
}

/**
 * A whitelist of origins, matched exactly. There is no wildcard form and no
 * "any origin" value — `'*'` fails here rather than matching everything.
 */
export const remoteOriginSchema = z
  .string()
  .url()
  .refine((value) => !value.includes('*'), { message: 'origins are matched exactly' })

/**
 * Named failures. A client that only sees a bare status code cannot tell a
 * revoked device from an unsupported version, and those need different words
 * on screen.
 */
export const remoteErrorCodeSchema = z.enum([
  'unauthenticated',
  'authentication_expired',
  'access_revoked',
  'origin_not_allowed',
  'unsupported_capability',
  'unsupported_version',
  'not_found',
  'conflict',
  'stale_snapshot',
  'idempotency_conflict',
  'invitation_expired',
  'invitation_used',
  'invalid_signature',
  'rate_limited',
  'internal_error',
])
export type RemoteErrorCode = z.infer<typeof remoteErrorCodeSchema>

export const remoteErrorSchema = z.object({
  code: remoteErrorCodeSchema,
  message: z.string(),
})
export type RemoteError = z.infer<typeof remoteErrorSchema>

/**
 * Idempotency keys are client-generated. Eight characters is enough that two
 * distinct commands cannot collide by accident; a key reused with a different
 * payload is rejected rather than silently applied.
 */
export const idempotencyKeySchema = z.string().min(8).max(200)

const clientCommandIdSchema = z.string().min(1).max(200)

/** Free-form, but never a path the client gets to choose. */
const sessionIdSchema = z.string().min(1).max(200)
const approvalIdSchema = z.string().min(1).max(200)

/**
 * Commands carrying an idempotency key; every mutation is one of these.
 *
 * Strict: a field this contract does not declare is an error, not something
 * to drop on the floor. A client asking for a permission mode it is not
 * entitled to must be told no, not handed a session quietly missing what it
 * asked for.
 */
const envelope = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({
      ...shape,
      clientCommandId: clientCommandIdSchema,
      idempotencyKey: idempotencyKeySchema,
    })
    .strict()

export const remoteCommandEnvelopeSchema = z.discriminatedUnion('op', [
  // Notably absent: `permissionMode`. The desktop's ceiling is authoritative
  // and mobile cannot raise it (ADR §5), so a session created from a phone
  // inherits whatever the host allows rather than asking for more — and the
  // strict envelope makes asking for it an error rather than a silent drop.
  envelope({
    op: z.literal('session.create'),
    projectId: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    driverKind: driverKindSchema.optional(),
    modelId: z.string().min(1).max(200).optional(),
  }),
  envelope({
    op: z.literal('session.prompt'),
    sessionId: sessionIdSchema,
    text: z.string().min(1),
    /** Staged attachment ids already uploaded; never raw paths. */
    attachmentIds: z.array(z.string().min(1)).optional(),
  }),
  envelope({
    op: z.literal('session.queue'),
    sessionId: sessionIdSchema,
    text: z.string().min(1),
    attachmentIds: z.array(z.string().min(1)).optional(),
  }),
  envelope({ op: z.literal('session.steer'), sessionId: sessionIdSchema, text: z.string().min(1) }),
  envelope({ op: z.literal('session.interrupt'), sessionId: sessionIdSchema }),
  envelope({ op: z.literal('session.archive'), sessionId: sessionIdSchema }),
  // The exact option the provider offered. The coarse decision vocabulary is
  // deliberately not accepted: a remote client always has the offered options
  // in hand, and two of them can share a kind.
  envelope({
    op: z.literal('approval.respond'),
    sessionId: sessionIdSchema,
    approvalId: approvalIdSchema,
    optionId: z.string().min(1),
  }),
  envelope({
    op: z.literal('input.respond'),
    sessionId: sessionIdSchema,
    inputId: z.string().min(1),
    value: z.string(),
  }),
  envelope({
    op: z.literal('changes.integrate'),
    sessionId: sessionIdSchema,
    snapshotCommit: z.string().min(1),
    allowStale: z.boolean().optional(),
  }),
])
export type RemoteCommand = z.infer<typeof remoteCommandEnvelopeSchema>

/** Reads carry no idempotency key: they change nothing and may repeat freely. */
export const remoteQuerySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('gateway.info') }),
  z.object({ op: z.literal('session.list') }),
  z.object({ op: z.literal('session.get'), sessionId: sessionIdSchema }),
  z.object({ op: z.literal('changes.files'), sessionId: sessionIdSchema }),
  z.object({ op: z.literal('changes.diff'), sessionId: sessionIdSchema, path: z.string().min(1) }),
  z.object({ op: z.literal('command.status'), idempotencyKey: idempotencyKeySchema }),
  z.object({ op: z.literal('device.list') }),
  z.object({ op: z.literal('device.revoke'), deviceId: z.string().min(1) }),
])
export type RemoteQuery = z.infer<typeof remoteQuerySchema>

/**
 * Content-free: a version to compare and the operation names this gateway
 * supports. No project names, file paths, or provider names — it answers
 * before anyone has authenticated.
 */
export const gatewayInfoSchema = z.object({
  protocolVersion: z.number().int().positive(),
  capabilities: z.array(remoteOperationSchema),
})
export type GatewayInfo = z.infer<typeof gatewayInfoSchema>

/** How the client proves possession of the key it registered. */
export const pairingKeySchema = z.object({
  /** ECDSA P-256, non-extractable, generated in the client's Web Crypto. */
  crv: z.literal('P-256'),
  kty: z.literal('EC'),
  x: z.string().min(1),
  y: z.string().min(1),
})
export type PairingPublicKey = z.infer<typeof pairingKeySchema>

export const pairingRequestSchema = z.object({
  invitationId: z.string().min(1),
  displayName: z.string().min(1).max(80),
  publicKey: pairingKeySchema,
})

export const pairingRedeemSchema = z.object({
  invitationId: z.string().min(1),
  /** The server's nonce, signed by the device key. */
  nonce: z.string().min(1),
  signature: z.string().min(1),
})

export const pairingStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired', 'redeemed'])
export type PairingStatus = z.infer<typeof pairingStatusSchema>

/**
 * A short code both screens display so the user can confirm they are looking
 * at the same device. Derived from the public key so it cannot be swapped
 * between the two views without the digits changing.
 */
export function pairingConfirmationCode(publicKeyMaterial: string): string {
  // FNV-1a: a stable, dependency-free digest. This is a comparison aid, not a
  // security primitive — the signature over the nonce is what proves the key.
  let hash = 0x811c9dc5
  for (let i = 0; i < publicKeyMaterial.length; i++) {
    hash ^= publicKeyMaterial.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const alphabet = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ' // no I or O: unreadable aloud
  let out = ''
  for (let i = 0; i < 8; i++) {
    hash = Math.imul(hash ^ (hash >>> 13), 0x01000193) >>> 0
    out += alphabet[hash % alphabet.length]
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

/**
 * Projected state plus the journal sequence it was taken at. The pair travels
 * together so a client can subscribe from exactly the high-water mark and see
 * neither a gap nor a duplicate.
 */
export const remoteSnapshotSchema = z.object({
  sessionId: sessionIdSchema,
  seq: z.number().int().nonnegative(),
  status: z.string().min(1),
  pendingApprovals: z.array(
    z.object({
      approvalId: approvalIdSchema,
      toolName: z.string(),
      summaryJson: z.string(),
      options: z.array(approvalOptionSchema),
    }),
  ),
})
export type RemoteSnapshot = z.infer<typeof remoteSnapshotSchema>

export const remoteJournalEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  event: z.unknown(),
})

export const remoteServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('events.frame'),
    sessionId: sessionIdSchema,
    events: z.array(remoteJournalEventSchema),
    /** Present only on the last frame of a replay, so the client knows it caught up. */
    caughtUp: z.boolean().optional(),
  }),
  z.object({ type: z.literal('events.desync'), sessionId: sessionIdSchema, reason: z.string() }),
  z.object({ type: z.literal('error'), error: remoteErrorSchema }),
])
export type RemoteServerMessage = z.infer<typeof remoteServerMessageSchema>

export const remoteClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('events.subscribe'),
    sessionId: sessionIdSchema,
    /** Resume point; absent asks for live frames from now. */
    fromSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('events.unsubscribe'), sessionId: sessionIdSchema }),
  z.object({ type: z.literal('events.ack'), sessionId: sessionIdSchema, seq: z.number().int().nonnegative() }),
])
export type RemoteClientMessage = z.infer<typeof remoteClientMessageSchema>

/**
 * How long an invitation stays valid. Short on purpose: it is displayed as a
 * QR code, which anyone who can see the screen can photograph.
 */
export const PAIRING_INVITATION_TTL_MS = 5 * 60 * 1000

export const pairingInvitationSchema = z.object({
  invitationId: z.string().min(1),
  expiresAt: timestampSchema,
  /** Origin the client should talk to; the id itself travels in the fragment. */
  gatewayOrigin: remoteOriginSchema,
})
export type PairingInvitation = z.infer<typeof pairingInvitationSchema>
