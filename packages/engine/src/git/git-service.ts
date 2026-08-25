import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { err, ok, type Result } from '@ari/shared/result'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('engine:git')

const execFileP = promisify(execFile)

/** Hard cap for diff payloads returned by {@link GitService.diffForRef}. */
export const DIFF_MAX_BYTES = 512 * 1024

const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

const NAME_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_REV = /^[A-Za-z0-9._/-]+$/

export type GitErrorCode =
  | 'git_missing'
  | 'command_failed'
  | 'invalid_ref'
  | 'output_overflow'
  | 'diff_too_large'

export interface GitError {
  code: GitErrorCode
  message: string
}

export type StatusKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'

export interface StatusEntry {
  /** Repo-relative path (rename target when applicable). */
  path: string
  /** True when the index already contains the change. */
  staged: boolean
  /**
   * Change category. When a path differs from both HEAD and the worktree,
   * the staged side classifies the entry; otherwise the worktree side does.
   */
  kind: StatusKind
}

export interface GitStatus {
  /** Checked-out branch name, `(detached)`, or `` when undeterminable. */
  branch: string
  files: StatusEntry[]
}

export interface CheckpointInfo {
  ref: string
  oid: string
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeInfo {
  /** Absolute path of the worktree checkout (or bare repo). */
  path: string
  /** Commit checked out in that worktree; empty for bare entries. */
  head: string
  /** Full ref name of the checked-out branch; null when detached or bare. */
  branch: string | null
  /** True for the bare repository row. */
  bare: boolean
  /** True when no branch is checked out (detached HEAD). */
  detached: boolean
}

export interface GitServiceOptions {
  /** git binary to invoke. Default `git`, resolved via PATH. */
  gitPath?: string
  /** Per-command timeout in milliseconds. Default 10s. */
  timeoutMs?: number
}

/**
 * Safe subprocess wrapper over the git CLI. Every command runs via
 * `execFile` (no shell), pinned to the workspace `cwd`, with a hard timeout.
 * All methods return typed Results; nothing throws for expected failures.
 *
 * Checkpoints are hidden refs under `refs/ari/<sessionId>/<turnId>` pinned to
 * HEAD at capture time, invisible to normal branch/ref listings.
 */
export class GitService {
  readonly #gitPath: string
  readonly #timeoutMs: number

  constructor(options: GitServiceOptions = {}) {
    this.#gitPath = options.gitPath ?? 'git'
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** True when `cwd` sits inside a git work tree. Quiet: a "no" is an answer, not a failure. */
  async isRepo(cwd: string): Promise<Result<boolean, GitError>> {
    const run = await this.#run(cwd, ['rev-parse', '--is-inside-work-tree'], DEFAULT_MAX_BYTES, {
      quiet: true,
    })
    if (run.ok) return ok(run.value.stdout.trim() === 'true')
    if (run.error.code === 'git_missing') return run
    return ok(false)
  }

  /** Working-tree status parsed from porcelain v2 output. */
  async status(cwd: string): Promise<Result<GitStatus, GitError>> {
    const run = await this.#run(cwd, ['status', '--porcelain=v2', '--branch'])
    return run.ok ? ok(parseStatus(run.value.stdout)) : run
  }

  /**
   * Captures a checkpoint: creates `refs/ari/<sessionId>/<turnId>` at the
   * current HEAD. Resolves `null` outside a git repo so callers degrade
   * gracefully; errors when HEAD does not resolve (e.g. no commits yet).
   */
  async captureCheckpoint(
    cwd: string,
    sessionId: string,
    turnId: string,
  ): Promise<Result<string | null, GitError>> {
    const inside = await this.isRepo(cwd)
    if (!inside.ok) return inside
    if (!inside.value) return ok(null)
    const ref = checkpointRef(sessionId, turnId)
    if (!ref.ok) return ref
    const head = await this.#run(cwd, ['rev-parse', '--verify', 'HEAD'])
    if (!head.ok) return head
    const updated = await this.#run(cwd, ['update-ref', ref.value, head.value.stdout.trim()])
    if (!updated.ok) return updated
    return ok(ref.value)
  }

  /** Lists captured checkpoints for a session in git's refname sort order. */
  async listCheckpoints(cwd: string, sessionId: string): Promise<Result<CheckpointInfo[], GitError>> {
    if (!NAME_COMPONENT.test(sessionId)) {
      return err({ code: 'invalid_ref', message: `invalid session id: ${sessionId}` })
    }
    const run = await this.#run(cwd, [
      'for-each-ref',
      '--format=%(refname)%09%(objectname)',
      `refs/ari/${sessionId}/`,
    ])
    if (!run.ok) return run
    const checkpoints: CheckpointInfo[] = []
    for (const line of run.value.stdout.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab === -1) continue
      checkpoints.push({ ref: line.slice(0, tab), oid: line.slice(tab + 1) })
    }
    return ok(checkpoints)
  }

  /**
   * Unified diff between a recorded revision and the current worktree
   * (tracked files only). Output is capped at {@link DIFF_MAX_BYTES};
   * larger diffs fail with code `diff_too_large`.
   */
  async diffForRef(cwd: string, gitRef: string): Promise<Result<string, GitError>> {
    const safe = assertSafeRev(gitRef)
    if (!safe.ok) return safe
    // Sessions on non-repo workspaces never have checkpoints; answer empty
    // instead of spraying git usage text into the log on every turn view.
    const inside = await this.isRepo(cwd)
    if (!inside.ok) return inside
    if (!inside.value) return ok('')
    const run = await this.#run(cwd, ['diff', gitRef], DIFF_MAX_BYTES)
    if (!run.ok) {
      if (run.error.code === 'output_overflow') {
        return err({
          code: 'diff_too_large',
          message: `diff exceeds ${DIFF_MAX_BYTES} byte cap`,
        })
      }
      return run
    }
    return ok(run.value.stdout.slice(0, DIFF_MAX_BYTES))
  }

  /**
   * Restores every tracked file to its state at `gitRef` using
   * `read-tree --reset -u`: index and worktree snap to the checkpoint tree,
   * files deleted since the checkpoint reappear, later tracked edits vanish.
   * Untracked files are intentionally left untouched (see tests).
   */
  async revertToRef(cwd: string, gitRef: string): Promise<Result<void, GitError>> {
    const safe = assertSafeRev(gitRef)
    if (!safe.ok) return safe
    const run = await this.#run(cwd, ['read-tree', '--reset', '-u', gitRef])
    return run.ok ? ok(undefined) : run
  }

  /**
   * Deletes checkpoint refs so at most `maxPerSession` remain per session,
   * keeping the newest by refname sort (turn ids are monotonic, so sort
   * order is recency order). Returns the refs that were deleted. Failures
   * on individual deletes are collected, not fatal — GC is best-effort.
   */
  async pruneCheckpoints(
    cwd: string,
    sessionId: string,
    maxPerSession: number,
  ): Promise<Result<string[], GitError>> {
    if (!Number.isInteger(maxPerSession) || maxPerSession < 0) {
      return err({ code: 'invalid_ref', message: `invalid cap: ${maxPerSession}` })
    }
    const listed = await this.listCheckpoints(cwd, sessionId)
    if (!listed.ok) return listed
    if (listed.value.length <= maxPerSession) return ok([])
    // for-each-ref sorts by refname; turn ids are monotonic, so the tail is newest.
    const excess = listed.value.slice(0, listed.value.length - maxPerSession)
    const deleted: string[] = []
    for (const { ref } of excess) {
      const run = await this.#run(cwd, ['update-ref', '-d', ref])
      if (run.ok) {
        deleted.push(ref)
      } else {
        log.warn('checkpoint prune delete failed', { ref, error: run.error.message })
      }
    }
    return ok(deleted)
  }

  /**
   * Registers `path` as a linked worktree:
   *
   * - `branch` omitted: detached-HEAD checkout at HEAD.
   * - mode `create-branch` (default): checks out a NEW branch
   *   (`git worktree add -b <branch> <path>`). Ari always passes an explicit
   *   per-session branch so agent commits never move a user-checked-out
   *   branch.
   * - mode `checkout-branch`: attaches to an EXISTING branch
   *   (`git worktree add <path> <branch>`), used to resurrect a session
   *   worktree whose checkout was removed while its branch survived.
   */
  async addWorktree(
    repo: string,
    path: string,
    branch?: string,
    mode: 'create-branch' | 'checkout-branch' = 'create-branch',
  ): Promise<Result<void, GitError>> {
    if (path.startsWith('-')) {
      return err({ code: 'invalid_ref', message: `unsafe worktree path: ${path}` })
    }
    if (
      branch !== undefined &&
      (branch.startsWith('-') || branch.includes('..') || branch.includes('\\') || !SAFE_REV.test(branch))
    ) {
      return err({ code: 'invalid_ref', message: `unsafe worktree branch: ${branch}` })
    }
    const args =
      branch === undefined
        ? ['worktree', 'add', path]
        : mode === 'create-branch'
          ? ['worktree', 'add', '-b', branch, path]
          : ['worktree', 'add', path, branch]
    const run = await this.#run(repo, args)
    return run.ok ? ok(undefined) : run
  }

  /**
   * Unlinks the worktree at `path`. Uses `--force`: session worktrees may
   * hold uncommitted agent output and cleanup must not wedge on dirty state.
   * The branch itself is left alone — deleting it is the caller's decision.
   */
  async removeWorktree(repo: string, path: string): Promise<Result<void, GitError>> {
    if (path.startsWith('-')) {
      return err({ code: 'invalid_ref', message: `unsafe worktree path: ${path}` })
    }
    const run = await this.#run(repo, ['worktree', 'remove', '--force', path])
    return run.ok ? ok(undefined) : run
  }

  /** Every linked worktree plus the main checkout, in git's listing order. */
  async listWorktrees(repo: string): Promise<Result<WorktreeInfo[], GitError>> {
    const run = await this.#run(repo, ['worktree', 'list', '--porcelain'])
    return run.ok ? ok(parseWorktrees(run.value.stdout)) : run
  }

  /**
   * Absolute path of the repo-local `info/exclude` file — ignore rules that
   * never touch the user's `.gitignore`. `--git-path` resolves shared files
   * into the common dir, so all linked worktrees agree on one file.
   */
  async infoExcludePath(cwd: string): Promise<Result<string, GitError>> {
    const run = await this.#run(cwd, ['rev-parse', '--git-path', 'info/exclude'])
    if (!run.ok) return run
    const raw = run.value.stdout.trim()
    if (raw.length === 0) {
      return err({ code: 'command_failed', message: 'git did not resolve info/exclude' })
    }
    // --git-path may answer with a cwd-relative path; pin it to the repo.
    return ok(resolve(cwd, raw))
  }

  async #run(
    cwd: string,
    args: string[],
    maxBytes: number = DEFAULT_MAX_BYTES,
    opts: { quiet?: boolean } = {},
  ): Promise<Result<{ stdout: string }, GitError>> {
    try {
      const { stdout } = await execFileP(this.#gitPath, args, {
        cwd,
        timeout: this.#timeoutMs,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: maxBytes,
      })
      return ok({ stdout })
    } catch (e) {
      if (opts.quiet !== true) {
        // execFile errors embed git's full stderr (a `diff` misuse dumps the
        // entire usage page); log one actionable line, not the flood.
        log.warn('git command failed', {
          args: args.join(' '),
          detail: stderrFirstLine(e),
        })
      }
      return err(toGitError(e, this.#gitPath, this.#timeoutMs))
    }
  }
}

function checkpointRef(sessionId: string, turnId: string): Result<string, GitError> {
  for (const part of [sessionId, turnId]) {
    if (!NAME_COMPONENT.test(part) || part.includes('..') || part.endsWith('.lock')) {
      return err({ code: 'invalid_ref', message: `invalid checkpoint name component: ${part}` })
    }
  }
  return ok(`refs/ari/${sessionId}/${turnId}`)
}

function assertSafeRev(rev: string): Result<string, GitError> {
  if (
    rev.length === 0 ||
    rev.startsWith('-') ||
    rev.includes('..') ||
    rev.includes('\\') ||
    !SAFE_REV.test(rev)
  ) {
    return err({ code: 'invalid_ref', message: `unsafe revision: ${rev}` })
  }
  return ok(rev)
}

function parseStatus(stdout: string): GitStatus {
  let branch = ''
  const files: StatusEntry[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length)
    } else if (line.startsWith('1 ')) {
      pushEntry(files, parseEntry(line, 8))
    } else if (line.startsWith('2 ')) {
      pushEntry(files, parseRename(line, 9))
    } else if (line.startsWith('u ')) {
      pushEntry(files, parseUnmerged(line, 10))
    } else if (line.startsWith('? ')) {
      files.push({ path: line.slice(2), staged: false, kind: 'untracked' })
    }
  }
  return { branch, files }
}

function pushEntry(files: StatusEntry[], entry: StatusEntry | null): void {
  if (entry) files.push(entry)
}

/**
 * Porcelain worktree listing: entries of `worktree`/`HEAD`/`branch` lines
 * (plus the `bare`/`detached`/`locked` flags) separated by blank lines.
 */
function parseWorktrees(stdout: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = []
  let current: WorktreeInfo | null = null
  for (const raw of stdout.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') {
      if (current) out.push(current)
      current = null
    } else if (line.startsWith('worktree ')) {
      if (current) out.push(current)
      current = {
        path: line.slice('worktree '.length),
        head: '',
        branch: null,
        bare: false,
        detached: false,
      }
    } else if (current) {
      if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length)
      } else if (line === 'bare') {
        current.bare = true
      } else if (line === 'detached') {
        current.detached = true
      }
    }
  }
  if (current) out.push(current)
  return out
}

/** Ordinary entries: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`. */
function parseEntry(line: string, leadFields: number): StatusEntry | null {
  const { fields, rest } = takeFields(line, leadFields)
  const xy = fields[1]
  if (!xy || xy.length < 2 || rest.length === 0) return null
  const staged = xy[0] !== '.'
  const ch = staged ? xy[0] : xy[1]
  return { path: rest, staged, kind: kindFromChar(ch ?? '') }
}

/** Rename/copy entries: `2 <XY> ... <hI> <X><score> <path>\t<origPath>`. */
function parseRename(line: string, leadFields: number): StatusEntry | null {
  const { fields, rest } = takeFields(line, leadFields)
  const xy = fields[1]
  if (!xy || xy.length < 2 || rest.length === 0) return null
  const path = rest.split('\t')[0] ?? rest
  const staged = xy[0] !== '.'
  const ch = staged ? xy[0] : xy[1]
  return { path, staged, kind: kindFromChar(ch ?? '') }
}

/** Unmerged entries: `u <XY> <sub> <m1..m3> <mW> <h1..h3> <path>`. */
function parseUnmerged(line: string, leadFields: number): StatusEntry | null {
  const { fields, rest } = takeFields(line, leadFields)
  const xy = fields[1]
  if (!xy || xy.length < 2 || rest.length === 0) return null
  return { path: rest, staged: true, kind: 'conflicted' }
}

function takeFields(line: string, count: number): { fields: string[]; rest: string } {
  const fields: string[] = []
  let pos = 0
  for (let i = 0; i < count; i++) {
    const space = line.indexOf(' ', pos)
    if (space === -1) {
      fields.push(line.slice(pos))
      return { fields, rest: '' }
    }
    fields.push(line.slice(pos, space))
    pos = space + 1
  }
  return { fields, rest: line.slice(pos) }
}

function kindFromChar(ch: string): StatusKind {
  switch (ch) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'U':
      return 'conflicted'
    default:
      return 'modified'
  }
}

function toGitError(e: unknown, gitPath: string, timeoutMs: number): GitError {
  const code = errnoCode(e)
  if (code === 'ENOENT') {
    return { code: 'git_missing', message: `git executable not found: ${gitPath}` }
  }
  if (code === 'ENOBUFS' || (code !== undefined && code.includes('MAXBUFFER'))) {
    return { code: 'output_overflow', message: 'git output exceeded the byte cap' }
  }
  const detail = stderrFirstLine(e)
  if (killedByTimeout(e)) {
    return {
      code: 'command_failed',
      message: `git timed out after ${timeoutMs}ms${detail ? `: ${detail}` : ''}`,
    }
  }
  return { code: 'command_failed', message: `git failed${detail ? `: ${detail}` : ''}` }
}

function errnoCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const value = (e as { code?: unknown }).code
    if (typeof value === 'string') return value
  }
  return undefined
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

/** Engine-facing adapter: capture-only view of the git service. */
export function newDefaultCapturer(): GitService {
  return new GitService()
}
