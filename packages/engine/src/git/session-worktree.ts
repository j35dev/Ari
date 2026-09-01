import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createLogger } from '@ari/shared/logger'
import { newDefaultCapturer, type GitService } from './git-service'

const log = createLogger('engine:git-worktree')

/** Directory name of the per-session worktree root inside a repo. */
const WORKTREE_DIR = '.ari'
const WORKTREE_SUBDIR = 'worktrees'

/** Session worktrees nest under this directory inside the repo. */
export const SESSION_WORKTREE_ROOT = `${WORKTREE_DIR}/${WORKTREE_SUBDIR}`

/** Branch namespace for per-session worktree branches. */
export const WORKTREE_BRANCH_PREFIX = 'ari'

/** Same component rules as checkpoint refs: safe in paths and branch names. */
const NAME_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Minimal surface of {@link GitService} the worktree helpers need; lets
 * callers substitute test doubles.
 */
export type WorktreeGitOps = Pick<
  GitService,
  'isRepo' | 'infoExcludePath' | 'listWorktrees' | 'addWorktree'
>

/** True when `sessionId` is safe to embed in a path and a branch name. */
export function isValidSessionId(sessionId: string): boolean {
  return NAME_COMPONENT.test(sessionId) && !sessionId.endsWith('.lock')
}

/** Checkout path for a session: `<repoRoot>/.ari/worktrees/<sessionId>`. */
export function sessionWorktreePath(repoRoot: string, sessionId: string): string {
  return join(repoRoot, WORKTREE_DIR, WORKTREE_SUBDIR, sessionId)
}

/** Per-session worktree branch: `ari/<sessionId>`. */
export function sessionWorktreeBranch(sessionId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}/${sessionId}`
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

async function samePath(a: string, b: string): Promise<boolean> {
  const canonical = async (path: string): Promise<string> => {
    const resolved = await realpath(path).catch(() => resolve(path))
    const normalized = normalizePath(resolved)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return (await canonical(a)) === (await canonical(b))
}

/**
 * Keeps `.ari/` out of `git status` by appending one idempotent line to the
 * repo-local `info/exclude` — never the user's `.gitignore`. Best-effort:
 * failure leaves `.ari/` visible as untracked but breaks nothing.
 */
async function excludeSessionDir(git: WorktreeGitOps, repoRoot: string): Promise<void> {
  const resolved = await git.infoExcludePath(repoRoot)
  if (!resolved.ok) {
    log.debug('info/exclude unresolved', { error: resolved.error.message })
    return
  }
  const file = resolved.value
  let content = ''
  try {
    content = await readFile(file, 'utf8')
  } catch {
    // Missing file: start fresh rather than failing the ensure.
  }
  if (content.split(/\r?\n/).some((line) => line.trim() === SESSION_WORKTREE_ROOT)) return
  const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n'
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${prefix}${SESSION_WORKTREE_ROOT}\n`, 'utf8')
  } catch (e) {
    log.warn('could not update info/exclude', { file, error: String(e) })
  }
}

/**
 * Ensures the per-session git worktree exists and returns its checkout path.
 *
 * Strategy (M19.3): every project-backed session runs inside its own linked
 * worktree at `<repoRoot>/.ari/worktrees/<sessionId>` checked out on branch
 * `ari/<sessionId>`, so concurrent agents never clobber one working copy and
 * agent commits stay off any user-checked-out branch. The `.ari/` tree stays
 * invisible via `info/exclude`; an existing worktree for the session is
 * reused so follow-up turns resume in place.
 *
 * Fail-soft by contract: anything unexpected — not a repo, invalid session
 * id, git missing, add failure — resolves `null` and the caller falls back
 * to running in `repoRoot` itself. Never throws.
 */
export async function ensureSessionWorktree(
  git: WorktreeGitOps,
  repoRoot: string,
  sessionId: string,
): Promise<string | null> {
  if (!isValidSessionId(sessionId)) return null
  const target = sessionWorktreePath(repoRoot, sessionId)
  try {
    const inside = await git.isRepo(repoRoot)
    if (!inside.ok || !inside.value) return null

    await excludeSessionDir(git, repoRoot)

    const listed = await git.listWorktrees(repoRoot)
    if (listed.ok) {
      for (const worktree of listed.value) {
        if (await samePath(worktree.path, target)) return target
      }
    }

    const branch = sessionWorktreeBranch(sessionId)
    const created = await git.addWorktree(repoRoot, target, branch)
    let ready = created.ok
    let failure = created.ok ? '' : created.error.message
    // The branch may survive an earlier worktree lifecycle (removed
    // checkout); attach to it instead of failing the session forever.
    if (!created.ok) {
      const attached = await git.addWorktree(repoRoot, target, branch, 'checkout-branch')
      ready = attached.ok
      failure = attached.ok ? '' : attached.error.message
    }
    if (!ready) {
      log.warn('worktree add failed; falling back to project folder', {
        sessionId,
        error: failure,
      })
      return null
    }
    log.info('session worktree ready', { sessionId, target })
    return target
  } catch (e) {
    log.warn('worktree ensure crashed; falling back to project folder', {
      sessionId,
      error: String(e),
    })
    return null
  }
}

/** Engine-facing adapter: real GitService-backed worktree source. */
export function newDefaultWorktreeSource(): {
  ensure: (repoPath: string, sessionId: string) => Promise<string | null>
} {
  const git = newDefaultCapturer()
  return { ensure: (repoPath, sessionId) => ensureSessionWorktree(git, repoPath, sessionId) }
}
