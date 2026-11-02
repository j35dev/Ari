import { z } from 'zod'
import type { GitPullRequest, SourceControlError } from '@ari/contracts/rpc'
import { err, ok, type Result } from '@ari/shared/result'
import { createLogger } from '@ari/shared/logger'
import { runHostCommand, type HostCommand } from './change-requests'

const log = createLogger('desktop:pull-request')
/** A PR's state changes rarely; the GitHub CLI costs a network round trip per call. */
const CACHE_MS = 60_000

const viewed = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  state: z.string(),
  isDraft: z.boolean().optional(),
})

const cache = new Map<string, { at: number; value: GitPullRequest | null }>()

function state(value: string): GitPullRequest['state'] {
  const lower = value.toLowerCase()
  return lower === 'merged' ? 'merged' : lower === 'closed' ? 'closed' : 'open'
}

/**
 * The pull request for the branch checked out at `cwd`, or null when there is
 * none or the GitHub CLI cannot say (not installed, signed out, not GitHub).
 */
export async function currentPullRequest(
  cwd: string,
  branch: string | null,
  options: { refresh?: boolean; run?: HostCommand; signal?: AbortSignal } = {},
): Promise<GitPullRequest | null> {
  if (!branch) return null
  const key = `${cwd}\0${branch}`
  const hit = cache.get(key)
  if (!options.refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value
  let value: GitPullRequest | null = null
  try {
    const { stdout } = await (options.run ?? runHostCommand)(
      'gh',
      ['pr', 'view', '--json', 'number,title,url,state,isDraft'],
      cwd,
      options.signal ?? new AbortController().signal,
    )
    const parsed = viewed.safeParse(JSON.parse(stdout))
    if (parsed.success)
      value = {
        number: parsed.data.number,
        title: parsed.data.title,
        url: parsed.data.url,
        state: state(parsed.data.state),
        isDraft: parsed.data.isDraft ?? false,
      }
  } catch {
    // `gh pr view` exits non-zero when the branch has no PR; that is the common answer.
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

/**
 * Opens a PR for the pushed branch with its title and body filled from the
 * commits. An existing PR for the branch is answered with its URL rather than
 * reported as a failure.
 */
export async function openPullRequest(
  cwd: string,
  options: { run?: HostCommand; signal?: AbortSignal; draft?: boolean } = {},
): Promise<Result<string | null, SourceControlError>> {
  try {
    const { stdout } = await (options.run ?? runHostCommand)(
      'gh',
      ['pr', 'create', '--fill', ...(options.draft ? ['--draft'] : [])],
      cwd,
      options.signal ?? new AbortController().signal,
    )
    forget(cwd)
    return ok(lastUrl(stdout))
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    const text =
      typeof stderr === 'string' && stderr.length > 0
        ? stderr
        : error instanceof Error
          ? error.message
          : 'gh failed'
    const existing = /already exists[^\n]*?(https:\/\/\S+)/.exec(text)?.[1]
    if (existing) return ok(existing)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return err({
        code: 'missing-tool',
        message: 'Install the GitHub CLI (gh) and sign in to create pull requests.',
      })
    log.warn('pull request creation failed', { error: text.slice(0, 300) })
    return err({
      code: 'failed',
      message: `Could not create the pull request: ${text.trim().split('\n').pop() ?? 'gh failed'}`,
    })
  }
}

function lastUrl(stdout: string): string | null {
  const urls = stdout.match(/https:\/\/\S+/g)
  return urls?.[urls.length - 1] ?? null
}

/** Drops cached answers for a worktree after something that changes its PR. */
export function forget(cwd: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${cwd}\0`)) cache.delete(key)
}
