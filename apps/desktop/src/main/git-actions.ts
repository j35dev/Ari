import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { GitActionResult } from '@ari/contracts/rpc'
import { err, ok, type Result } from '@ari/shared/result'

const execFileP = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 1024 * 1024

export interface GitActionsOptions {
  /** Per-command timeout in milliseconds. Default 60s. */
  timeoutMs?: number
}

export type GitActionCode = 'invalid_input' | 'command_failed'

export interface GitActionError {
  code: GitActionCode
  message: string
}

/**
 * Mutating git helpers for the `git.add` / `git.commit` / `git.push` RPCs
 * (M19.5). Every command runs via `execFile` with `shell: false` — arguments
 * are passed as argv elements, so repo content can never inject shell
 * syntax — pinned to the workspace `cwd`, under a hard timeout. All
 * functions return typed Results; nothing throws for expected failures.
 */

/** Stages the given pathspecs (`git add -- <paths>`). `['.']` is honored
 * only when passed explicitly; an empty list is refused. The `--`
 * separator forces every argument to be read as a pathspec, and git itself
 * refuses pathspecs resolving outside the worktree.
 */
export async function stage(
  cwd: string,
  paths: readonly string[],
  options: GitActionsOptions = {},
): Promise<Result<void, GitActionError>> {
  if (paths.length === 0 || paths.some((p) => p.trim().length === 0)) {
    return err({ code: 'invalid_input', message: 'at least one non-empty pathspec is required' })
  }
  const run = await runGit(cwd, ['add', '--', ...paths], timeoutOf(options))
  return run.ok ? ok(undefined) : run
}

/** Commits the current index (`git commit -m <message>`); whitespace-only
 * messages are rejected before git runs.
 */
export async function commit(
  cwd: string,
  message: string,
  options: GitActionsOptions = {},
): Promise<Result<void, GitActionError>> {
  if (message.trim().length === 0) {
    return err({ code: 'invalid_input', message: 'commit message is required' })
  }
  const run = await runGit(cwd, ['commit', '-m', message], timeoutOf(options))
  return run.ok ? ok(undefined) : run
}

/**
 * Pushes the current branch to `remote` (default `origin`) via an explicit
 * `HEAD` refspec, which resolves to the same-named remote branch regardless
 * of the user's `push.default` configuration.
 */
export async function push(
  cwd: string,
  remote: string = 'origin',
  options: GitActionsOptions = {},
): Promise<Result<void, GitActionError>> {
  // A leading dash would be parsed as a git flag (e.g. `--force`).
  if (remote.trim().length === 0 || remote.startsWith('-')) {
    return err({ code: 'invalid_input', message: `invalid remote: ${remote}` })
  }
  const run = await runGit(cwd, ['push', remote, 'HEAD'], timeoutOf(options))
  return run.ok ? ok(undefined) : run
}

/**
 * Handler wrapper: jails `cwd` to an existing directory (the same boundary
 * as `git.status`/`fs.list`), runs the action, and maps every outcome into a
 * plain {@link GitActionResult} so failures never throw across IPC.
 */
export async function performGitAction(
  cwd: string,
  action: () => Promise<Result<void, GitActionError>>,
): Promise<GitActionResult> {
  const info = await stat(cwd).catch(() => null)
  if (info === null || !info.isDirectory()) {
    return { ok: false, error: 'path must be an existing project directory' }
  }
  const result = await action()
  return result.ok ? { ok: true } : { ok: false, error: result.error.message }
}

function timeoutOf(options: GitActionsOptions): number {
  return options.timeoutMs ?? DEFAULT_TIMEOUT_MS
}

async function runGit(
  cwd: string,
  args: string[],
  timeoutMs: number,
): Promise<Result<string, GitActionError>> {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      timeout: timeoutMs,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
    })
    return ok(stdout)
  } catch (e) {
    const detail = stderrFirstLine(e)
    if (killedByTimeout(e)) {
      return err({
        code: 'command_failed',
        message: `git timed out after ${timeoutMs}ms${detail ? `: ${detail}` : ''}`,
      })
    }
    return err({ code: 'command_failed', message: `git failed${detail ? `: ${detail}` : ''}` })
  }
}

function killedByTimeout(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { killed?: unknown }).killed === true
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
