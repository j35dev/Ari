import { z } from 'zod'
import { projectAgentSchema } from './project'

export const TRIAGE_REPOSITORY = 'j35dev/Ari'
export const TRIAGE_REPOSITORY_URL = `https://github.com/${TRIAGE_REPOSITORY}`
export const triageIdSchema = z.string().regex(/^triage_[a-f0-9]{32}$/)
export const triageDraftSchema = z
  .object({ title: z.string().trim().min(1).max(240), body: z.string().max(60_000) })
  .strict()
export type TriageDraft = z.infer<typeof triageDraftSchema>
const publicationSchema = z
  .object({ number: z.number().int().positive(), url: z.string().url() })
  .strict()
export const triageCaseSchema = z
  .object({
    version: z.literal(1),
    id: triageIdSchema,
    description: z.string().trim().min(1).max(16_000),
    createdAt: z.number(),
    updatedAt: z.number(),
    phase: z.enum(['ready', 'investigating', 'fixing', 'review']),
    projectId: z.string().nullable(),
    fixProjectId: z.string().nullable(),
    investigationSessionId: z.string().nullable(),
    fixSessionId: z.string().nullable(),
    agent: projectAgentSchema.nullable(),
    fixAgent: projectAgentSchema.nullable(),
    includeLogs: z.boolean().nullable(),
    source: z
      .object({
        revision: z.string().regex(/^[a-f0-9]{40,64}$/),
        match: z.enum(['exact', 'approximate']),
      })
      .nullable(),
    sourceError: z.string().nullable(),
    fixBase: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .nullable(),
    fixBranch: z.string().nullable(),
    issueDraft: triageDraftSchema,
    prDraft: triageDraftSchema,
    issue: publicationSchema.nullable(),
    pr: publicationSchema.nullable(),
    issueReceipt: z.object({ hash: z.string(), pending: z.boolean() }).nullable(),
    prReceipt: z
      .object({ hash: z.string(), pending: z.boolean(), commit: z.string().nullable() })
      .nullable(),
    verification: z
      .object({
        revision: z.string(),
        passed: z.boolean(),
        at: z.number(),
        output: z.string().max(32_768),
      })
      .nullable(),
  })
  .strict()
export type TriageCase = z.infer<typeof triageCaseSchema>
export const triageContextSchema = z
  .object({
    version: z.literal(1),
    appVersion: z.string(),
    buildCommit: z.string().nullable(),
    profile: z.string(),
    machine: z.string(),
    platform: z.string(),
    arch: z.string(),
    osRelease: z.string(),
    nodeVersion: z.string(),
    electronVersion: z.string().nullable(),
    collectedAt: z.number(),
    providers: z.array(
      z.object({ kind: z.string(), version: z.string().nullable(), status: z.string() }),
    ),
    logs: z.string().max(1_048_576),
    exclusions: z.array(z.string()),
  })
  .strict()
export type TriageContext = z.infer<typeof triageContextSchema>
export interface TriageSnapshot {
  case: TriageCase
  context: TriageContext
}
export interface TriageMatch {
  number: number
  title: string
  url: string
  state: string
  kind: 'issue' | 'pr'
}
const caseParam = z.object({ id: triageIdSchema }).strict()
export const triageRpcParams = {
  'triage.account': z.undefined(),
  'triage.list': z.undefined(),
  'triage.prepare': z.object({ description: z.string().trim().min(1).max(16_000) }).strict(),
  'triage.get': caseParam,
  'triage.recover': caseParam,
  'triage.start': caseParam
    .extend({
      agent: projectAgentSchema,
      mode: z.enum(['investigate', 'fix']),
      includeLogs: z.boolean(),
    })
    .strict(),
  'triage.refreshDraft': caseParam.extend({ kind: z.enum(['issue', 'pr']) }).strict(),
  'triage.saveDraft': caseParam
    .extend({ kind: z.enum(['issue', 'pr']), draft: triageDraftSchema })
    .strict(),
  'triage.search': caseParam.extend({ query: z.string().trim().min(1).max(300) }).strict(),
  'triage.publishIssue': caseParam
    .extend({ draft: triageDraftSchema, account: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/) })
    .strict(),
  'triage.publishPr': caseParam
    .extend({
      draft: triageDraftSchema,
      account: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/),
      revision: z.string().regex(/^[a-f0-9]{40,64}$/),
    })
    .strict(),
  'triage.verify': caseParam,
  'triage.diff': caseParam,
  'triage.captureError': z
    .object({ message: z.string().max(8000), area: z.string().max(100) })
    .strict(),
}
export interface TriageRpcResults {
  'triage.account': { account: string | null; error: string | null }
  'triage.list': TriageCase[]
  'triage.prepare': TriageSnapshot
  'triage.get': TriageSnapshot
  'triage.recover': TriageCase
  'triage.start': TriageSnapshot
  'triage.refreshDraft': TriageCase
  'triage.saveDraft': TriageCase
  'triage.search': TriageMatch[]
  'triage.publishIssue': TriageCase
  'triage.publishPr': TriageCase
  'triage.verify': TriageCase
  'triage.diff': { diff: string; branch: string; verificationCurrent: boolean; revision: string }
  'triage.captureError': { recorded: boolean }
}
