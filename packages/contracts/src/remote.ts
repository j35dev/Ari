import { z } from 'zod'
import {
  approvalOptionSchema,
  driverKindSchema,
  sessionStatusSchema,
  timestampSchema,
} from './common'
import { attachmentRefSchema, MAX_ATTACHMENTS } from './attachments'

/**
 * The remote surface is an allowlist, not a filter.
 *
 * Everything a paired phone may do is named here; an operation with no schema
 * has no route, so the gateway cannot perform what was never declared. Shell
 * terminals require a separate desktop pairing grant. Provider login,
 * arbitrary filesystem roots and API-key configuration have no remote route.
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
  'session.fork',
  'session.archive',
  'session.update',
  'attention.list',
  'files.list',
  'files.read',
  'attachments.stage',
  'attachments.read',
  'terminal.create',
  'terminal.read',
  'terminal.write',
  'terminal.resize',
  'terminal.kill',
  // Projects. A name and an id, never a path: the phone names a project to
  // start work in, and has no use for where it lives on someone's disk.
  'project.list',
  // Models. What the desktop can actually run right now, so the phone offers
  // a choice instead of a text field it cannot validate.
  'models.list',
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
  'changes.preview',
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

/** Portable workspace-relative paths; absolute paths and traversal have no remote meaning. */
export const remoteFilePathSchema = z
  .string()
  .max(1024)
  .refine(
    (path) =>
      path === '' ||
      path
        .split('/')
        .every(
          (part) =>
            part.length > 0 &&
            part !== '.' &&
            part !== '..' &&
            !/[. ]$/.test(part) &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
            !/[\\:]/.test(part) &&
            [...part].every((char) => char.charCodeAt(0) >= 32),
        ),
    { message: 'expected a workspace-relative path' },
  )

/** Remote uploads stay small enough for a phone and are raster images only. */
export const MAX_REMOTE_IMAGE_BYTES = 1024 * 1024
export const remoteImageUploadSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    dataBase64: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_REMOTE_IMAGE_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict()

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
    text: z.string(),
    /** Staged attachment ids already uploaded; never raw paths. */
    attachmentIds: z.array(z.string().min(1).max(128)).max(MAX_ATTACHMENTS).optional(),
  }),
  envelope({
    op: z.literal('session.fork'),
    sessionId: sessionIdSchema,
    title: z.string().trim().min(1).max(120),
    driverKind: driverKindSchema.optional(),
    modelId: z.string().min(1).max(200).optional(),
  }),
  envelope({
    op: z.literal('session.queue'),
    sessionId: sessionIdSchema,
    text: z.string(),
    attachmentIds: z.array(z.string().min(1).max(128)).max(MAX_ATTACHMENTS).optional(),
  }),
  envelope({ op: z.literal('session.steer'), sessionId: sessionIdSchema, text: z.string().min(1) }),
  envelope({ op: z.literal('session.interrupt'), sessionId: sessionIdSchema }),
  envelope({ op: z.literal('session.archive'), sessionId: sessionIdSchema }),
  envelope({
    op: z.literal('session.update'),
    sessionId: sessionIdSchema,
    title: z.string().trim().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    modelId: z.string().min(1).max(200).nullable().optional(),
  }),
  envelope({
    op: z.literal('attachments.stage'),
    sessionId: sessionIdSchema,
    files: z.array(remoteImageUploadSchema).min(1).max(1),
  }),
  envelope({
    op: z.literal('terminal.create'),
    sessionId: sessionIdSchema,
    cols: z.number().int().min(20).max(300).default(80),
    rows: z.number().int().min(5).max(100).default(24),
  }),
  envelope({
    op: z.literal('terminal.write'),
    sessionId: sessionIdSchema,
    terminalId: z.string().min(1).max(128),
    data: z.string().min(1).max(16_384),
  }),
  envelope({
    op: z.literal('terminal.resize'),
    sessionId: sessionIdSchema,
    terminalId: z.string().min(1).max(128),
    cols: z.number().int().min(20).max(300),
    rows: z.number().int().min(5).max(100),
  }),
  envelope({
    op: z.literal('terminal.kill'),
    sessionId: sessionIdSchema,
    terminalId: z.string().min(1).max(128),
  }),
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
    snapshotCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    expectedParentSnapshot: z.string().regex(/^[a-f0-9]{40,64}$/),
  }),
])
export type RemoteCommand = z.infer<typeof remoteCommandEnvelopeSchema>

/** Only the child identifier from native delegation leaves the fork adapter. */
export const remoteForkNativeResultSchema = z.object({ child: z.object({ id: sessionIdSchema }) })

/** Reads carry no idempotency key: they change nothing and may repeat freely. */
export const remoteQuerySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('gateway.info') }),
  z.object({ op: z.literal('session.list') }),
  z.object({ op: z.literal('session.get'), sessionId: sessionIdSchema }),
  z
    .object({
      op: z.literal('attention.list'),
      cursor: sessionIdSchema.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  z
    .object({
      op: z.literal('files.list'),
      sessionId: sessionIdSchema,
      path: remoteFilePathSchema.default(''),
      cursor: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(200).default(100),
    })
    .strict(),
  z
    .object({
      op: z.literal('files.read'),
      sessionId: sessionIdSchema,
      path: remoteFilePathSchema.refine((path) => path.length > 0),
    })
    .strict(),
  z
    .object({
      op: z.literal('attachments.read'),
      sessionId: sessionIdSchema,
      attachmentId: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      op: z.literal('terminal.read'),
      sessionId: sessionIdSchema,
      terminalId: z.string().min(1).max(128),
      fromSeq: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z.object({ op: z.literal('project.list') }),
  z.object({ op: z.literal('models.list') }),
  z.object({ op: z.literal('changes.files'), sessionId: sessionIdSchema }),
  z.object({ op: z.literal('changes.preview'), sessionId: sessionIdSchema }).strict(),
  z.object({ op: z.literal('changes.diff'), sessionId: sessionIdSchema, path: z.string().min(1) }),
  z.object({ op: z.literal('command.status'), idempotencyKey: idempotencyKeySchema }),
  z.object({ op: z.literal('device.list') }),
  z.object({ op: z.literal('device.revoke'), deviceId: z.string().min(1) }),
])
export type RemoteQuery = z.infer<typeof remoteQuerySchema>

export const remoteChangeFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  isNew: z.boolean().optional(),
  isDeleted: z.boolean().optional(),
  isBinary: z.boolean().optional(),
  hunks: z.array(
    z.object({
      header: z.string(),
      lines: z.array(
        z.object({
          type: z.enum(['context', 'add', 'del']),
          content: z.string(),
          oldLineNo: z.number().int().positive().optional(),
          newLineNo: z.number().int().positive().optional(),
        }),
      ),
    }),
  ),
})
export type RemoteChangeFile = z.infer<typeof remoteChangeFileSchema>

export const remoteChangesSchema = z.object({
  files: z.array(remoteChangeFileSchema.omit({ hunks: true })),
  base: z.enum(['workspace-head', 'session-base']),
  error: z.string().nullable(),
})
export type RemoteChanges = z.infer<typeof remoteChangesSchema>

export const remoteChangeDiffSchema = z.object({
  file: remoteChangeFileSchema.nullable(),
  error: z.string().nullable(),
})

/**
 * A project as a phone may name it. The path is deliberately absent: starting
 * a session needs the id, and a filesystem location is the desktop's business.
 */
export const remoteProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Session count, so the picker can say how much work is already there. */
  sessionCount: z.number().int().nonnegative(),
})
export type RemoteProject = z.infer<typeof remoteProjectSchema>

/**
 * The desktop's runnable providers and their models, as the phone's picker
 * shows them. Ids are the desktop's own catalog entries — the same ones its
 * picker offers — so a choice made on the phone names something the desktop
 * accepts. No keys, paths, or provider logins travel with it.
 */
export const remoteModelCatalogSchema = z.object({
  providers: z.array(
    z.object({
      driverKind: driverKindSchema,
      models: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })),
    }),
  ),
})
export type RemoteModelCatalog = z.infer<typeof remoteModelCatalogSchema>

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

export const connectJwksSchema = z.object({
  keys: z
    .array(
      pairingKeySchema.extend({
        alg: z.literal('ES256'),
        use: z.literal('sig'),
        kid: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(4),
})
export type ConnectJwks = z.infer<typeof connectJwksSchema>

export const connectLeaseClaimsSchema = z
  .object({
    iss: z.string().url(),
    aud: z.string(),
    sub: z.string().min(1),
    computerId: z.string().min(1),
    deviceId: z.string().min(1),
    deviceKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    projectIds: z.array(z.string().min(1)).max(100),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    jti: z.string().min(1),
  })
  .strict()

export const connectDesktopStartSchema = z.object({
  transactionId: z.string().min(8).max(128),
  browserUrl: z.string().url(),
  pollToken: z.string().min(16).max(256),
  expiresAt: z.string().datetime(),
  intervalSeconds: z.number().int().min(5).max(30),
})
export const connectDesktopPollSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('approved'),
    computer: z.object({
      computerId: z.string().min(8).max(128),
      name: z.string().min(1).max(80),
      credential: z.string().min(16).max(256),
    }),
  }),
])
export const connectComputerSchema = z.object({
  computer: z.object({
    computerId: z.string().min(8).max(128),
    name: z.string(),
    hostname: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
    state: z.enum([
      'registered',
      'provisioning',
      'ready',
      'offline',
      'failed',
      'suspended',
      'deleting',
      'deleted',
    ]),
    provision: z.object({
      attempts: z.number().int().nonnegative(),
      lastError: z.string().nullable(),
      nextAttemptAt: z.string().datetime().nullable(),
    }),
  }),
})
export const connectConnectorSchema = z.object({
  computerId: z.string().min(8).max(128),
  hostname: z.string(),
  token: z.string().min(16).max(4096),
})
export const connectStoredStateSchema = z.object({
  origin: z.string().url(),
  computerId: z.string().min(8).max(128).nullable(),
  computerName: z.string().max(80).nullable(),
  secretCipher: z.string().max(16_384).nullable(),
  publicKey: pairingKeySchema.nullable(),
  port: z.number().int().min(1).max(65535),
  jwks: connectJwksSchema.nullable(),
  disconnectPending: z.boolean().default(false),
})
export const connectStoredSecretSchema = z.object({
  credential: z.string().min(16).max(256),
  privateKeyPem: z.string().max(8192),
})

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
 * An approval as a client must render it: the tool, the detail behind it, and
 * the exact choices the provider offered, in the provider's order.
 *
 * The choices are data rather than a message, because two of them can share a
 * kind — Codex advertises both a session-scoped and a prefix-scoped persistent
 * grant — and one generic "always allow" button would silently answer the
 * wrong one.
 */
export const remoteApprovalSchema = z.object({
  approvalId: approvalIdSchema,
  toolName: z.string(),
  summaryJson: z.string(),
  options: z.array(approvalOptionSchema),
})
export type RemoteApproval = z.infer<typeof remoteApprovalSchema>

/** An agent question awaiting an answer, with its choices when it has any. */
export const remoteInputSchema = z.object({
  inputId: approvalIdSchema,
  prompt: z.string(),
  choicesJson: z.string().nullable(),
})
export type RemoteInput = z.infer<typeof remoteInputSchema>

export const remoteAttentionSchema = z.object({
  items: z.array(
    z.object({
      sessionId: sessionIdSchema,
      projectId: z.string(),
      title: z.string(),
      status: sessionStatusSchema,
      updatedAt: timestampSchema,
      seq: z.number().int().nonnegative(),
      pendingApprovals: z.array(remoteApprovalSchema),
      pendingInputs: z.array(remoteInputSchema),
      error: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
})
export type RemoteAttention = z.infer<typeof remoteAttentionSchema>

export const remoteFilesSchema = z.object({
  path: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      kind: z.enum(['file', 'directory']),
      size: z.number().int().nonnegative().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
  error: z.string().nullable(),
})
export type RemoteFiles = z.infer<typeof remoteFilesSchema>

export const remoteFileSchema = z.object({
  path: z.string(),
  kind: z.enum(['text', 'binary', 'too-large']).nullable(),
  size: z.number().int().nonnegative().nullable(),
  content: z.string().nullable(),
  error: z.string().nullable(),
})
export type RemoteFile = z.infer<typeof remoteFileSchema>

export const remoteAttachmentSchema = z.object({
  attachment: attachmentRefSchema.omit({ id: true }).extend({ dataBase64: z.string() }).nullable(),
  error: z.string().nullable(),
})

export const remoteTerminalSchema = z.object({
  terminalId: z.string(),
  data: z.string(),
  seq: z.number().int().nonnegative(),
  reset: z.boolean(),
  exited: z.boolean(),
  hasMore: z.boolean(),
  error: z.string().nullable(),
})
export type RemoteTerminal = z.infer<typeof remoteTerminalSchema>

export const remoteIntegrationPreviewSchema = z.object({
  sessionId: z.string(),
  parentSessionId: z.string(),
  snapshotCommit: z.string(),
  expectedParentSnapshot: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.string(),
      additions: z.number(),
      deletions: z.number(),
      binary: z.boolean(),
    }),
  ),
})
export type RemoteIntegrationPreview = z.infer<typeof remoteIntegrationPreviewSchema>

/**
 * Projected state plus the journal sequence it was taken at. The pair travels
 * together so a client can subscribe from exactly the high-water mark and see
 * neither a gap nor a duplicate.
 *
 * The pending items are here rather than only in the event stream on purpose:
 * a phone that opens a session while an approval is already waiting never saw
 * the event that announced it, and would otherwise show a session that looks
 * idle while the agent sits blocked.
 */
export const remoteSnapshotSchema = z.object({
  sessionId: sessionIdSchema,
  seq: z.number().int().nonnegative(),
  status: z.string().min(1),
  pendingApprovals: z.array(remoteApprovalSchema),
  pendingInputs: z.array(remoteInputSchema),
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
  z.object({
    type: z.literal('events.ack'),
    sessionId: sessionIdSchema,
    seq: z.number().int().nonnegative(),
  }),
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
