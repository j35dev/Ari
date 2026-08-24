import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { err, ok, type Result } from '@ari/shared/result'

const execFileP = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 120_000

export interface CreatePrInput {
  title: string
  body?: string
  /** Base branch; omitted lets gh pick the default branch. */
  base?: string
}

export type CreatePrError =
  | { code: 'invalid_input'; message: string }
  | { code: 'gh_missing'; message: string }
  | { code: 'command_failed'; message: string }

/**
 * Opens a pull request through the GitHub CLI (`gh pr create`) in the given
 * repo folder. The runner is injectable for tests. Returns the created PR's
 * URL parsed from gh output when available.
 */
export async function createPullRequest(
  cwd: string,
  input: CreatePrInput,
  options: {
    timeoutMs?: number
    run?: (args: string[]) => Promise<{ stdout: string }>
  } = {},
): Promise<Result<string, CreatePrError>> {
  const title = input.title.trim()
  if (title.length === 0) {
    return err({ code: 'invalid_input', message: 'a PR title is required' })
  }
  const base = input.base?.trim() ?? ''
  if (base.startsWith('-')) {
    return err({ code: 'invalid_input', message: `invalid base ref: ${base}` })
  }

  const args = ['pr', 'create', '--title', title]
  const body = input.body?.trim()
  if (body !== undefined && body.length > 0) args.push('--body', body)
  if (base.length > 0) args.push('--base', base)

  try {
    const { stdout } =
      options.run !== undefined
        ? await options.run(args)
        : await execFileP('gh', args, {
            cwd,
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            shell: false,
            windowsHide: true,
            encoding: 'utf8',
          })
    const match = /https:\/\/\S+/.exec(stdout)
    return ok(match?.[0] ?? '')
  } catch (e) {
    if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT') {
      return err({
        code: 'gh_missing',
        message: 'the GitHub CLI (gh) is not installed — get it at cli.github.com, then authenticate with `gh auth login`',
      })
    }
    const detail = stderrFirstLine(e)
    return err({ code: 'command_failed', message: `gh pr create failed${detail ? `: ${detail}` : ''}` })
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
