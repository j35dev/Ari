import { z } from 'zod'
import { driverKindSchema, permissionModeSchema } from './common'
import { projectAgentSchema } from './project'
import { journalEventSchema } from './events'
import { sourceControlSchemas } from './source-control'
const gitHistoryEntrySchema = z.object({ oid: sourceControlSchemas.oid, subject: z.string().max(8000), author: z.string().max(500), at: z.string().max(100) }).strict()

const id = z.string().min(1).max(200)
const short = z.string().max(500)
const seq = z.number().int().min(-1)
const text = z.string().max(256 * 1024)
const path = z.string().min(1).max(1024).refine((value) =>
  value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' &&
    !/[\\:\u0000-\u001f]/.test(part) && !/[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
  'expected a workspace-relative path')

/** Additive desktop vocabulary. The legacy remoteOperationSchema never grows. */
export const machinesExtensionOperationSchema = z.enum([
  'project.catalog', 'project.workspaces', 'host.resources', 'host.permissions', 'host.version',
  'session.desktop.get', 'session.desktop.create', 'session.dequeue', 'session.provider.switch',
  'session.stopChildren', 'session.resume.get', 'session.resume.schedule', 'session.resume.cancel',
  'plan.get', 'changes.turn', 'changes.turnFile', 'files.index', 'pastes.stage',
  'session.steer.attachments', 'scm.desktop.summary', 'scm.desktop.status', 'scm.desktop.review',
  'events.desktop.subscribe', 'scm.desktop.diff',
])
export type MachinesExtensionOperation = z.infer<typeof machinesExtensionOperationSchema>
export const machinesExtensionsSchema = z.object({
  version: z.literal(1),
  operations: z.array(machinesExtensionOperationSchema).max(100),
}).strict()
export type MachinesExtensions = z.infer<typeof machinesExtensionsSchema>

const repositoryKey = z.string().min(3).max(1024).regex(/^[^\s/@:?#\\]+\/[^\s:?#\\]+$/)
export const remoteRepositoryIdentitySchema = z.object({
  canonicalKey: repositoryKey,
  displayName: z.string().min(1).max(512),
  locator: z.object({ source: z.literal('git-remote'), remoteName: id }).strict(),
  origin: z.object({ canonicalKey: repositoryKey, displayName: z.string().min(1).max(512) }).strict().optional(),
}).strict()
export type RemoteRepositoryIdentity = z.infer<typeof remoteRepositoryIdentitySchema>
export const remoteProjectCatalogEntrySchema = z.object({
  id, name: z.string().min(1).max(200), sessionCount: z.number().int().nonnegative(),
  status: z.enum(['ok', 'missing']), defaultAgent: projectAgentSchema.strict().nullable(),
  repositoryIdentity: remoteRepositoryIdentitySchema.nullable(),
}).strict()
export type RemoteProjectCatalogEntry = z.infer<typeof remoteProjectCatalogEntrySchema>
export const remoteProjectCatalogSchema = z.object({ projects: z.array(remoteProjectCatalogEntrySchema).max(512) }).strict()
export type RemoteProjectCatalog = z.infer<typeof remoteProjectCatalogSchema>
export const remoteHostResourcesSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), sampledAt: z.number().int().nonnegative(),
    cpuUtilization: z.number().min(0).max(1), cpuCount: z.number().int().min(1).max(4096),
    availableMemoryBytes: z.number().int().nonnegative(), totalMemoryBytes: z.number().int().positive(),
    reason: z.null(), }).strict().refine((value) => value.availableMemoryBytes <= value.totalMemoryBytes),
  z.object({ status: z.literal('unavailable'), sampledAt: z.number().int().nonnegative().nullable(),
    cpuUtilization: z.null(), cpuCount: z.null(), availableMemoryBytes: z.null(), totalMemoryBytes: z.null(),
    reason: short, }).strict(),
])
export type RemoteHostResources = z.infer<typeof remoteHostResourcesSchema>
export const remoteHostPermissionsSchema = z.object({
  deviceId: id,
  projectScope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('all') }).strict(),
    z.object({ kind: z.literal('ids'), projectIds: z.array(id).max(512) }).strict(),
  ]),
  allowTerminal: z.boolean(), managedLeaseExpiresAt: z.number().int().positive().nullable(),
}).strict()
export type RemoteHostPermissions = z.infer<typeof remoteHostPermissionsSchema>
export const remoteHostVersionSchema = z.object({
  ariVersion: z.string().min(1).max(100), protocolVersion: z.number().int().positive(),
  hostingMode: z.enum(['desktop', 'headless']),
  update: z.object({ supported: z.literal(false), reason: short, availableVersion: z.string().max(100).nullable(),
    stagedVersion: z.string().max(100).nullable(), guidance: short }).strict(),
}).strict()
export type RemoteHostVersion = z.infer<typeof remoteHostVersionSchema>
export const remoteProjectWorkspacesSchema = z.object({
  projectId: id,
  options: z.array(z.object({ token: id, label: z.string().min(1).max(240),
    kind: z.enum(['checkout', 'branch', 'worktree']), branch: z.string().max(240).nullable(),
    workspaceMode: z.enum(['auto', 'isolated', 'shared']), }).strict()).max(200),
  truncated: z.boolean(),
}).strict()
export type RemoteProjectWorkspaces = z.infer<typeof remoteProjectWorkspacesSchema>

const read = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict()
const write = <T extends z.ZodRawShape>(shape: T) => read({ ...shape,
  clientCommandId: id, idempotencyKey: z.string().min(8).max(200) })
export const remoteDesktopQuerySchema = z.discriminatedUnion('op', [
  read({ op: z.literal('project.catalog') }), read({ op: z.literal('host.resources') }),
  read({ op: z.literal('host.permissions') }), read({ op: z.literal('host.version') }),
  read({ op: z.literal('project.workspaces'), projectId: id }),
  read({ op: z.literal('session.desktop.get'), sessionId: id }),
  read({ op: z.literal('session.resume.get'), sessionId: id }),
  read({ op: z.literal('plan.get'), sessionId: id }),
  read({ op: z.literal('changes.turn'), sessionId: id, turnId: id }),
  read({ op: z.literal('changes.turnFile'), sessionId: id, turnId: id, path }),
  read({ op: z.literal('files.index'), sessionId: id, cursor: path.optional(), limit: z.number().int().min(1).max(200).default(200) }),
  read({ op: z.literal('scm.desktop.summary'), sessionId: id }),
  read({ op: z.literal('scm.desktop.status'), sessionId: id }),
  read({ op: z.literal('scm.desktop.diff'), sessionId: id, snapshotId: sourceControlSchemas.oid, path,
    context: z.number().int().min(0).max(1000).default(3) }),
  read({ op: z.literal('scm.desktop.review'), sessionId: id,
    comparison: z.discriminatedUnion('kind', [read({ kind: z.literal('working-tree') }),
      read({ kind: z.literal('staged') }), read({ kind: z.literal('unstaged') }),
      read({ kind: z.literal('session') }), read({ kind: z.literal('turn'), turnId: id })]) }),
])
export type RemoteDesktopQuery = z.infer<typeof remoteDesktopQuerySchema>
const attachmentIds = z.array(z.string().min(1).max(128)).max(4).optional()
export const remoteDesktopCommandSchema = z.discriminatedUnion('op', [
  write({ op: z.literal('session.desktop.create'), projectId: id, title: z.string().min(1).max(200),
    driverKind: driverKindSchema, modelId: z.string().min(1).max(200).nullable(),
    effort: z.string().min(1).max(64).nullable(), permissionMode: permissionModeSchema,
    workspaceToken: id.optional(), workspaceMode: z.enum(['auto', 'isolated', 'shared']).default('auto') }),
  write({ op: z.literal('session.dequeue'), sessionId: id, text, attachmentIds }),
  write({ op: z.literal('session.steer.attachments'), sessionId: id, text, attachmentIds }),
  write({ op: z.literal('session.provider.switch'), sessionId: id, driverKind: driverKindSchema,
    modelId: z.string().min(1).max(200).nullable(), effort: z.string().min(1).max(64).nullable() }),
  write({ op: z.literal('session.stopChildren'), sessionId: id }),
  write({ op: z.literal('session.resume.schedule'), sessionId: id, at: z.number().int().positive() }),
  write({ op: z.literal('session.resume.cancel'), sessionId: id }),
  write({ op: z.literal('pastes.stage'), sessionId: id, text }),
])
export type RemoteDesktopCommand = z.infer<typeof remoteDesktopCommandSchema>

export const remoteDesktopClientMessageSchema = read({ type: z.literal('events.desktop.subscribe'),
  sessionId: id, fromSeq: z.number().int().nonnegative().optional() })
export const remoteDesktopFrameSchema = read({
  type: z.literal('events.desktop.frame'), sessionId: id,
  frame: z.discriminatedUnion('kind', [
    read({ kind: z.literal('start'), replayMode: z.enum(['full', 'resume']), fromSeq: seq.nullable(), throughSeq: seq }),
    read({ kind: z.literal('chunk'), events: z.array(journalEventSchema).min(1).max(128) }),
    read({ kind: z.literal('terminal'), replayOutcome: z.enum(['complete', 'incomplete']), seq,
      liveTurnId: id.nullable(), reason: short.nullable() }),
    read({ kind: z.literal('live'), event: journalEventSchema }),
  ]),
})
export type RemoteDesktopFrame = z.infer<typeof remoteDesktopFrameSchema>

const outcome = <T extends z.ZodType>(value: T) => z.discriminatedUnion('ok', [
  read({ ok: z.literal(true), value }), read({ ok: z.literal(false), error: sourceControlSchemas.error.strict() }),
])
export const remoteScmSummarySchema = outcome(read({ branch: z.string().max(240).nullable(), changedFiles: z.number().int().nonnegative(),
  upstream: z.string().max(240).nullable(), ahead: z.number().int().nonnegative(), behind: z.number().int().nonnegative(),
  hasRemote: z.boolean(), operation: sourceControlSchemas.status.shape.operation,
  canCreateRequest: z.boolean().optional(), requestKind: z.enum(['pull', 'merge']).optional() }))
export const remoteScmStatusSchema = outcome(read({
  workspace: read({ kind: z.enum(['project', 'managed-worktree']), path: z.literal('.') }).optional(),
  status: sourceControlSchemas.status.extend({ files: z.array(sourceControlSchemas.file).max(2000),
    remotes: z.array(read({ name: z.string().max(128), url: z.literal('') })).max(100) }).strict(),
  refs: z.array(z.string().max(240)).max(2000), commits: z.array(gitHistoryEntrySchema).max(200),
  stashes: z.array(gitHistoryEntrySchema).max(200),
  turns: z.array(read({ turnId: id, stable: z.boolean(), error: short.optional() })).max(2000),
}))
export const remoteScmReviewSchema = outcome(sourceControlSchemas.manifest.extend({ files: z.array(sourceControlSchemas.file).max(2000) }).strict())
export const remoteScmDiffSchema = outcome(z.string().max(4 * 1024 * 1024))
export const remotePlanSchema = read({ items: z.array(read({ text: z.string().min(1).max(8000),
  status: z.enum(['pending', 'in_progress', 'done']) })).max(500).nullable(), error: short.optional() })
export const remoteTurnDiffSchema = read({ diffText: z.string().max(4 * 1024 * 1024).nullable(),
  summary: read({ baseOid: sourceControlSchemas.oid, headOid: sourceControlSchemas.oid,
    files: z.array(sourceControlSchemas.file).max(2000) }).optional(), error: short.optional() })
export const remoteTurnFileSchema = read({ diffText: z.string().max(4 * 1024 * 1024).nullable(), tooLarge: z.boolean().optional(), error: short.optional() })
export const remoteFilesIndexSchema = read({ paths: z.array(path).max(200), nextCursor: path.nullable(), truncated: z.boolean() })
export type RemoteFilesIndex = z.infer<typeof remoteFilesIndexSchema>
export const remoteDesktopCommandResultSchemas = {
  'session.desktop.create': read({ sessionId: id }),
  'session.dequeue': read({ accepted: z.literal(true) }),
  'session.steer.attachments': read({ accepted: z.literal(true) }),
  'session.provider.switch': read({ accepted: z.literal(true), switchTiming: z.discriminatedUnion('effective', [
    read({ effective: z.literal('ready'), afterTurnId: z.null() }), read({ effective: z.literal('next_turn'), afterTurnId: id }),
  ]) }),
  'session.stopChildren': read({ stopped: z.number().int().nonnegative() }),
  'session.resume.schedule': read({ at: z.number().int().positive() }),
  'session.resume.cancel': read({ cancelled: z.boolean() }),
  'pastes.stage': read({ path, bytesWritten: z.number().int().nonnegative().max(256 * 1024) }),
} as const
export const remoteDesktopQueryResultSchemas = {
  'project.catalog': remoteProjectCatalogSchema, 'project.workspaces': remoteProjectWorkspacesSchema,
  'host.resources': remoteHostResourcesSchema, 'host.permissions': remoteHostPermissionsSchema, 'host.version': remoteHostVersionSchema,
  'session.resume.get': read({ at: z.number().int().positive().nullable() }), 'plan.get': remotePlanSchema,
  'changes.turn': remoteTurnDiffSchema, 'changes.turnFile': remoteTurnFileSchema, 'files.index': remoteFilesIndexSchema,
  'scm.desktop.summary': remoteScmSummarySchema, 'scm.desktop.status': remoteScmStatusSchema, 'scm.desktop.review': remoteScmReviewSchema,
  'scm.desktop.diff': remoteScmDiffSchema,
} as const

export const localHostIdentitySchema = read({ machineId: id, name: z.string().min(1).max(100) })
