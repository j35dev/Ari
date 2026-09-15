import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { err, ok, type Result } from '@ari/shared/result'

const execFileP = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 30_000
const GH_MISSING_MESSAGE =
  'the GitHub CLI (gh) is not installed — get it at cli.github.com, then authenticate with `gh auth login`'

const PR_LIST_FIELDS = 'number,title,url,state,isDraft,author,labels,updatedAt,headRefName'
const ISSUE_LIST_FIELDS = 'number,title,url,state,author,labels,updatedAt'
const PR_VIEW_FIELDS = `${PR_LIST_FIELDS},body,baseRefName,additions,deletions`
const ISSUE_VIEW_FIELDS = `${ISSUE_LIST_FIELDS},body`

const ghUserSchema = z.object({ login: z.string().min(1) }).passthrough()
const ghLabelSchema = z
  .object({ name: z.string().min(1), color: z.string().optional() })
  .passthrough()

const ghItemSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string().min(1),
    state: z.string().min(1),
    isDraft: z.boolean().optional(),
    author: ghUserSchema.nullable().optional(),
    labels: z.array(ghLabelSchema).optional(),
    updatedAt: z.string().min(1),
    headRefName: z.string().optional(),
    body: z.string().nullable().optional(),
    baseRefName: z.string().optional(),
    additions: z.number().int().optional(),
    deletions: z.number().int().optional(),
  })
  .passthrough()

export type HubKind = 'pr' | 'issue'
export type HubListState = 'open' | 'closed' | 'all'

export interface HubLabel {
  name: string
  color?: string
}

export interface HubItem {
  kind: HubKind
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  author: string
  labels: HubLabel[]
  updatedAt: string
  headRefName?: string
  baseRefName?: string
  body: string
  additions?: number
  deletions?: number
}

export type HubError =
  | { code: 'invalid_input'; message: string }
  | { code: 'gh_missing'; message: string }
  | { code: 'command_failed'; message: string }

export type GhRunner = (args: string[]) => Promise<{ stdout: string }>

function defaultRun(cwd: string, timeoutMs: number): GhRunner {
  return async (args) => {
    const { stdout } = await execFileP('gh', args, {
      cwd,
      timeout: timeoutMs,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    })
    return { stdout }
  }
}

function mapItem(kind: HubKind, raw: z.infer<typeof ghItemSchema>): HubItem {
  return {
    kind,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    isDraft: raw.isDraft === true,
    author: raw.author?.login ?? 'unknown',
    labels: (raw.labels ?? []).map((label) =>
      label.color !== undefined ? { name: label.name, color: label.color } : { name: label.name },
    ),
    updatedAt: raw.updatedAt,
    body: raw.body ?? '',
    ...(raw.headRefName !== undefined ? { headRefName: raw.headRefName } : {}),
    ...(raw.baseRefName !== undefined ? { baseRefName: raw.baseRefName } : {}),
    ...(raw.additions !== undefined ? { additions: raw.additions } : {}),
    ...(raw.deletions !== undefined ? { deletions: raw.deletions } : {}),
  }
}

function asHubError(e: unknown, action: string): HubError {
  if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT') {
    return { code: 'gh_missing', message: GH_MISSING_MESSAGE }
  }
  const detail = stderrFirstLine(e)
  return {
    code: 'command_failed',
    message: `${action} failed${detail ? `: ${detail}` : ''}`,
  }
}

function stderrFirstLine(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'stderr' in e) {
    const stderr = (e as { stderr?: unknown }).stderr
    if (typeof stderr === 'string') {
      return stderr.trim().split('\n')[0] ?? ''
    }
  }
  return ''
}

async function runJson(
  cwd: string,
  args: string[],
  action: string,
  options: { timeoutMs?: number; run?: GhRunner } = {},
): Promise<Result<unknown, HubError>> {
  const run = options.run ?? defaultRun(cwd, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const { stdout } = await run(args)
    try {
      return ok(JSON.parse(stdout) as unknown)
    } catch {
      return err({ code: 'command_failed', message: `${action} failed: unreadable gh output` })
    }
  } catch (e) {
    return err(asHubError(e, action))
  }
}

/** Lists pull requests or issues in a repo folder through `gh`. */
export async function listHubItems(
  cwd: string,
  input: { kind: HubKind; state?: HubListState; limit?: number },
  options: { timeoutMs?: number; run?: GhRunner } = {},
): Promise<Result<HubItem[], HubError>> {
  const state = input.state ?? 'open'
  const limit = input.limit ?? 50
  if (limit < 1 || limit > 100) {
    return err({ code: 'invalid_input', message: 'limit must be between 1 and 100' })
  }
  const noun = input.kind === 'pr' ? 'pr' : 'issue'
  const fields = input.kind === 'pr' ? PR_LIST_FIELDS : ISSUE_LIST_FIELDS
  const parsed = await runJson(
    cwd,
    [noun, 'list', '--state', state, '--limit', String(limit), '--json', fields],
    `gh ${noun} list`,
    options,
  )
  if (!parsed.ok) return parsed
  const items = z.array(ghItemSchema).safeParse(parsed.value)
  if (!items.success) {
    return err({ code: 'command_failed', message: `gh ${noun} list failed: unexpected payload` })
  }
  return ok(items.data.map((item) => mapItem(input.kind, item)))
}

/** Loads one pull request or issue through `gh`. */
export async function viewHubItem(
  cwd: string,
  input: { kind: HubKind; number: number },
  options: { timeoutMs?: number; run?: GhRunner } = {},
): Promise<Result<HubItem, HubError>> {
  if (!Number.isInteger(input.number) || input.number < 1) {
    return err({ code: 'invalid_input', message: 'a positive issue or PR number is required' })
  }
  const noun = input.kind === 'pr' ? 'pr' : 'issue'
  const fields = input.kind === 'pr' ? PR_VIEW_FIELDS : ISSUE_VIEW_FIELDS
  const parsed = await runJson(
    cwd,
    [noun, 'view', String(input.number), '--json', fields],
    `gh ${noun} view`,
    options,
  )
  if (!parsed.ok) return parsed
  const item = ghItemSchema.safeParse(parsed.value)
  if (!item.success) {
    return err({ code: 'command_failed', message: `gh ${noun} view failed: unexpected payload` })
  }
  return ok(mapItem(input.kind, item.data))
}
