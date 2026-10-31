import { z } from 'zod'

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const revision = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes('..') && !value.endsWith('.lock'))
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => {
    const parts = value.split(/[\\/]/)
    return (
      !value.includes('\0') &&
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !/^[A-Za-z]:/.test(value) &&
      parts.every((part) => part !== '..' && part !== '.') &&
      parts[0] !== '.git'
    )
  }, 'a repository-relative file path is required')
const comparison = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('working-tree') }),
  z.object({ kind: z.literal('unstaged') }),
  z.object({ kind: z.literal('staged') }),
  z.object({ kind: z.literal('branch'), base: revision.optional() }),
  z.object({ kind: z.literal('session') }),
  z.object({ kind: z.literal('turn'), turnId: z.string().min(1).max(128) }),
  z.object({ kind: z.literal('commit'), ref: revision }),
])
const changeKind = z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked', 'conflicted'])
const file = z.object({
  path,
  oldPath: path.optional(),
  kind: changeKind,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  staged: z.boolean(),
  unstaged: z.boolean(),
})
const manifest = z.object({
  id: oid,
  comparison,
  baseOid: oid,
  headOid: oid,
  baseLabel: z.string(),
  headLabel: z.string(),
  branch: z.string().nullable(),
  live: z.boolean(),
  files: z.array(file),
  truncated: z.boolean(),
  checkedAt: z.number().int().nonnegative(),
})
const note = z
  .object({
    id: z.string().min(1).max(128),
    comparisonId: oid,
    path,
    side: z.enum(['old', 'new']),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    context: z.string().max(8000),
    text: z.string().trim().min(1).max(8000),
  })
  .refine((value) => value.endLine >= value.startLine, 'the range must be ordered')
const provider = z.enum(['github', 'gitlab', 'forgejo', 'bitbucket', 'azure-devops', 'gitcafe'])
const instance = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  }, 'an HTTPS instance URL without credentials or query parameters is required')
const repository = z.object({
  provider: provider.nullable(),
  instance,
  name: z.string().min(1).max(512),
  remote: z.string().min(1).max(128),
  url: z.string().url(),
})
const capabilities = z.object({
  diff: z.boolean(),
  comments: z.boolean(),
  review: z.array(z.enum(['comment', 'approve', 'request-changes'])),
  inlineReview: z.boolean(),
  merge: z.array(z.enum(['merge', 'squash', 'rebase'])),
  draft: z.boolean(),
  close: z.boolean(),
})
const changeRequest = z.object({
  repository,
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  url: z.string().url(),
  author: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  base: z.string(),
  head: z.string(),
  headOid: oid.nullable(),
  updatedAt: z.string(),
  capabilities,
})
const hostConnection = z.object({
  repository: repository.nullable(),
  requests: z.array(changeRequest),
  detail: z.string().max(500),
})
const status = z.object({
  branch: z.string().nullable(),
  headOid: oid.nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(file),
  remotes: z.array(z.object({ name: z.string(), url: z.string() })),
  operation: z.enum(['merge', 'rebase', 'cherry-pick', 'revert']).nullable(),
})
const error = z.object({
  code: z.enum([
    'not-repository',
    'missing-tool',
    'invalid-input',
    'unavailable',
    'too-large',
    'stale',
    'busy',
    'unauthenticated',
    'unsupported',
    'rate-limited',
    'failed',
  ]),
  message: z.string(),
})

/** Validated, renderer-independent source-control models; credentials never appear in read models. */
export const sourceControlSchemas = {
  oid,
  revision,
  path,
  comparison,
  file,
  manifest,
  note,
  provider,
  instance,
  repository,
  capabilities,
  changeRequest,
  hostConnection,
  status,
  error,
}

export type GitComparison = z.infer<typeof comparison>
export type GitReviewFile = z.infer<typeof file>
export type GitReviewManifest = z.infer<typeof manifest>
export type GitReviewNote = z.infer<typeof note>
export type SourceControlProvider = z.infer<typeof provider>
export type SourceControlRepository = z.infer<typeof repository>
export type ChangeRequest = z.infer<typeof changeRequest>
export type ChangeRequestCapabilities = z.infer<typeof capabilities>
export type HostConnection = z.infer<typeof hostConnection>
export type SourceControlStatus = z.infer<typeof status>
export type SourceControlError = z.infer<typeof error>
