import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { sourceControlSchemas, type HostConnection } from '@ari/contracts/rpc'
import type { SourceControlError } from '@ari/contracts/rpc'
import { processEnvWithPath, resolveDetectionEnvironment } from '@ari/providers/shell-env'
import { err, ok, type Result } from '@ari/shared/result'
import { chooseHost, type ClassifiedHost } from './host-remote'

const execFileP = promisify(execFile)
const NONE: HostConnection['requests'][number]['capabilities'] = {
  diff: false,
  comments: false,
  review: [],
  inlineReview: false,
  merge: [],
  draft: false,
  close: false,
}
const GH_FIELDS =
  'number,title,body,url,state,isDraft,author,updatedAt,headRefName,baseRefName,headRefOid'
const ghItem = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  url: z.string().url(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  author: z.object({ login: z.string() }).nullable().optional(),
  updatedAt: z.string(),
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
  headRefOid: z.string().nullable().optional(),
})
const glItem = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().optional(),
  web_url: z.string().url(),
  state: z.string(),
  draft: z.boolean().optional(),
  author: z.object({ username: z.string() }).nullable().optional(),
  source_branch: z.string().optional(),
  target_branch: z.string().optional(),
  sha: z.string().nullable().optional(),
  updated_at: z.string(),
})

export type HostCommand = (
  command: 'gh' | 'glab',
  args: string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<{ stdout: string }>

function requestState(value: string): 'open' | 'closed' | 'merged' | null {
  const state = value.toLowerCase()
  if (state === 'open' || state === 'opened') return 'open'
  if (state === 'merged') return 'merged'
  if (state === 'closed' || state === 'locked') return 'closed'
  return null
}

function oid(value: string | null | undefined): string | null {
  return value && sourceControlSchemas.oid.safeParse(value).success ? value : null
}

function repositoryOf(host: ClassifiedHost): HostConnection['repository'] {
  return {
    provider: host.provider,
    instance: host.instance,
    name: host.name,
    remote: host.remote,
    url: host.url,
  }
}

function detail(message: string): string {
  return message.slice(0, 500)
}

function failureDetail(error: unknown, command: 'gh' | 'glab', noun: string): string {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return command === 'gh'
      ? 'GitHub CLI (gh) is not installed.'
      : 'GitLab CLI (glab) is not installed.'
  }
  const stderr =
    typeof error === 'object' &&
    error !== null &&
    'stderr' in error &&
    typeof error.stderr === 'string'
      ? error.stderr.trim().split('\n')[0]
      : ''
  return detail(stderr ? `Could not list ${noun}: ${stderr}` : `Could not list ${noun}.`)
}

function fromJson(
  host: ClassifiedHost,
  items: HostConnection['requests'],
  message: string,
): Result<HostConnection, SourceControlError> {
  const parsed = sourceControlSchemas.hostConnection.safeParse({
    repository: repositoryOf(host),
    requests: items,
    detail: detail(message),
  })
  return parsed.success
    ? ok(parsed.data)
    : err({ code: 'failed', message: 'Change requests did not match the contract.' })
}

function mapGh(host: ClassifiedHost, payload: unknown): HostConnection['requests'] {
  const parsed = z.array(z.unknown()).safeParse(payload)
  if (!parsed.success) return []
  return parsed.data.flatMap((item) => {
    const row = ghItem.safeParse(item)
    if (!row.success) return []
    const state = requestState(row.data.state)
    if (!state) return []
    const request = {
      repository: repositoryOf(host),
      number: row.data.number,
      title: row.data.title,
      body: row.data.body ?? '',
      url: row.data.url,
      author: row.data.author?.login ?? 'unknown',
      state,
      draft: row.data.isDraft === true,
      base: row.data.baseRefName ?? '',
      head: row.data.headRefName ?? '',
      headOid: oid(row.data.headRefOid),
      updatedAt: row.data.updatedAt,
      capabilities: NONE,
    }
    const checked = sourceControlSchemas.changeRequest.safeParse(request)
    return checked.success ? [checked.data] : []
  })
}

function mapGl(host: ClassifiedHost, payload: unknown): HostConnection['requests'] {
  const parsed = z.array(z.unknown()).safeParse(payload)
  if (!parsed.success) return []
  return parsed.data.flatMap((item) => {
    const row = glItem.safeParse(item)
    if (!row.success) return []
    const state = requestState(row.data.state)
    if (!state) return []
    const request = {
      repository: repositoryOf(host),
      number: row.data.iid,
      title: row.data.title,
      body: row.data.description ?? '',
      url: row.data.web_url,
      author: row.data.author?.username ?? 'unknown',
      state,
      draft: row.data.draft === true,
      base: row.data.target_branch ?? '',
      head: row.data.source_branch ?? '',
      headOid: oid(row.data.sha),
      updatedAt: row.data.updated_at,
      capabilities: NONE,
    }
    const checked = sourceControlSchemas.changeRequest.safeParse(request)
    return checked.success ? [checked.data] : []
  })
}

/** Lists open GitHub pull requests or GitLab merge requests. Other forges stay recognized only. */
export async function listChangeRequests(
  cwd: string,
  remotes: readonly { name: string; url: string }[],
  options: { run: HostCommand; signal: AbortSignal },
): Promise<Result<HostConnection, SourceControlError>> {
  if (options.signal.aborted) return err({ code: 'unavailable', message: 'Request cancelled.' })
  const host = chooseHost(remotes)
  if (!host) {
    return ok({
      repository: null,
      requests: [],
      detail: 'No recognized hosting remote. Ari does not guess a private host.',
    })
  }
  if (!host.listable) {
    return fromJson(
      host,
      [],
      `${host.label} is recognized. Listing, review, and merge are not connected.`,
    )
  }
  const command = host.provider === 'gitlab' ? 'glab' : 'gh'
  const noun = command === 'glab' ? 'merge requests' : 'pull requests'
  const args =
    command === 'glab'
      ? ['mr', 'list', '--output', 'json', '--per-page', '30']
      : ['pr', 'list', '--state', 'open', '--limit', '30', '--json', GH_FIELDS]
  try {
    const { stdout } = await options.run(command, args, cwd, options.signal)
    const payload: unknown = JSON.parse(stdout)
    const requests = (command === 'glab' ? mapGl(host, payload) : mapGh(host, payload)).slice(0, 30)
    const count = requests.length
    const message =
      count === 0
        ? `No open ${noun}.`
        : count === 1
          ? `1 open ${noun.slice(0, -1)}.`
          : `${count} open ${noun}.`
    return fromJson(host, requests, message)
  } catch (error) {
    if (options.signal.aborted) return err({ code: 'unavailable', message: 'Request cancelled.' })
    if (error instanceof SyntaxError) return fromJson(host, [], `Could not read ${noun}.`)
    return fromJson(host, [], failureDetail(error, command, noun))
  }
}

/** Runs gh or glab with the same enriched PATH the GitHub hub uses. */
export async function runHostCommand(
  command: 'gh' | 'glab',
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ stdout: string }> {
  const { pathEnv } = await resolveDetectionEnvironment()
  const { stdout } = await execFileP(command, args, {
    cwd,
    timeout: 30_000,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    env: processEnvWithPath(pathEnv),
    signal,
  })
  return { stdout: String(stdout) }
}
