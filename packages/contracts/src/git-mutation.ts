import { z } from 'zod'
import { sourceControlSchemas as scm } from './source-control'

const base = { snapshotId: scm.oid }
const paths = z.array(scm.path).min(1).max(500)
const remote = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)

/** Mutations are explicit intents against a reviewed snapshot, never arbitrary Git arguments. */
export const gitMutationSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('stage'), paths }),
  z.object({ ...base, kind: z.literal('unstage'), paths }),
  z.object({ ...base, kind: z.literal('discard'), paths, confirmed: z.literal(true) }),
  z.object({ ...base, kind: z.literal('commit'), message: z.string().trim().min(1).max(8000) }),
  z.object({ ...base, kind: z.literal('push'), remote, confirmed: z.literal(true) }),
  z.object({ ...base, kind: z.literal('fetch'), remote }),
  z.object({ ...base, kind: z.literal('pull'), confirmed: z.literal(true) }),
  z.object({ ...base, kind: z.literal('branch'), name: scm.revision, create: z.boolean(), confirmed: z.literal(true) }),
  z.object({ ...base, kind: z.literal('stash'), message: z.string().max(256), confirmed: z.literal(true) }),
  z.object({ ...base, kind: z.literal('apply-stash'), oid: scm.oid, confirmed: z.literal(true) }),
])

export type GitMutation = z.infer<typeof gitMutationSchema>
export interface GitMutationOutcome { recoveryRef?: string; message: string }
export interface GitHistoryEntry { oid: string; subject: string; author: string; at: string }
