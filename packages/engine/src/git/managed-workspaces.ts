import { mkdtemp, mkdir, readdir, rm, writeFile, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ControlFailure } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { GitService } from './git-service'

const oid = /^[a-f0-9]{40,64}$/
const component = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Non-destructive snapshots and explicit three-way integration in Ari-owned worktrees. */
export class ManagedWorkspaces {
  constructor(
    readonly rootDir: string,
    readonly git = new GitService({ timeoutMs: 60_000 }),
  ) {}

  async #run(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await this.git.runPlumbing(cwd, args, env)
    if (!result.ok)
      throw new ControlFailure(
        result.error.code === 'output_overflow' ? 'output_too_large' : 'integration_failed',
        result.error.message,
      )
    return result.value.stdout
  }

  #ref(id: string): string {
    if (!component.test(id))
      throw new ControlFailure('invalid_request', 'Invalid session identifier.')
    return `refs/ari/orchestration/${id}`
  }

  /** Captures working files without touching the branch, HEAD or real index. */
  async snapshot(cwd: string, ref: string, parent?: string): Promise<string> {
    if (!/^refs\/ari\/orchestration\/[A-Za-z0-9_/-]+$/.test(ref) || ref.includes('..'))
      throw new ControlFailure('invalid_request', 'Invalid snapshot ref.')
    if (parent && !oid.test(parent))
      throw new ControlFailure('invalid_request', 'Invalid base commit.')
    const inside = await this.git.isRepo(cwd)
    if (!inside.ok || !inside.value)
      throw new ControlFailure('workspace_not_git', 'Isolated workers require a Git repository.')
    const scratch = await mkdtemp(join(tmpdir(), 'ari-snapshot-'))
    try {
      const env = {
        ...process.env,
        GIT_INDEX_FILE: join(scratch, 'index'),
        GIT_AUTHOR_NAME: 'Ari',
        GIT_AUTHOR_EMAIL: 'ari@localhost',
        GIT_COMMITTER_NAME: 'Ari',
        GIT_COMMITTER_EMAIL: 'ari@localhost',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      }
      const head = (await this.#run(cwd, ['rev-parse', '--verify', 'HEAD'])).trim()
      await this.#run(cwd, ['read-tree', 'HEAD'], env)
      await this.#run(cwd, ['add', '--all', '--', '.'], env)
      const tree = (await this.#run(cwd, ['write-tree'], env)).trim()
      const commit = (
        await this.#run(
          cwd,
          ['commit-tree', tree, '-p', parent ?? head, '-m', 'Ari workspace snapshot'],
          env,
        )
      ).trim()
      await this.#run(cwd, ['update-ref', ref, commit])
      return commit
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  async isolate(
    parent: Session,
    cwd: string,
    childId: string,
  ): Promise<NonNullable<Session['workspace']>> {
    if (!component.test(parent.projectId))
      throw new ControlFailure('invalid_request', 'Invalid project identifier.')
    const baseRef = `${this.#ref(childId)}/base`
    const baseCommit = await this.snapshot(cwd, baseRef)
    const path = join(this.rootDir, parent.projectId, childId)
    const branch = `ari/${(parent.rootSessionId ?? parent.id).slice(-12)}/${childId}`
    await mkdir(join(this.rootDir, parent.projectId), { recursive: true })
    const result = await this.git.addWorktree(cwd, path, branch, 'create-branch', baseCommit)
    if (!result.ok) throw new ControlFailure('worktree_create_failed', result.error.message)
    return { kind: 'managed-worktree', path, branch, baseRef, baseCommit }
  }

  /**
   * Removes every Ari-owned trace of a child session: the linked worktree
   * (registration and directory), its `ari/…` branch, and all refs under
   * `refs/ari/orchestration/<sessionId>/` (base, current and snapshots).
   * Missing pieces are success, so destroy paths can call it unconditionally
   * and repeat it safely.
   */
  async release(sessionId: string): Promise<void> {
    const prefix = this.#ref(sessionId)
    const paths = await this.#sessionPaths(sessionId)
    const repos: string[] = []
    for (const path of paths) {
      const repo = await this.#mainRepo(path)
      if (repo && !repos.includes(repo)) repos.push(repo)
      if (repo) {
        const removed = await this.git.removeWorktree(repo, path)
        if (!removed.ok) {
          await rm(path, { recursive: true, force: true })
          await this.git.runPlumbing(repo, ['worktree', 'prune'])
        }
      } else {
        await rm(path, { recursive: true, force: true })
      }
    }
    for (const repo of repos) {
      await this.#deleteSessionBranches(repo, sessionId)
      const refs = await this.git.runPlumbing(repo, [
        'for-each-ref',
        '--format=%(refname)',
        `${prefix}/`,
      ])
      if (!refs.ok) continue
      for (const line of refs.value.stdout.split('\n')) {
        const name = line.trim()
        if (!name.startsWith(`${prefix}/`)) continue
        await this.git.runPlumbing(repo, ['update-ref', '-d', name])
      }
    }
  }

  /**
   * Deletes per-diff snapshot refs for a session, keeping only
   * `snapshots/<keepCurrent>`. Base and current pointers are left alone, so
   * repeated diffs collapse back to one snapshot ref.
   */
  async pruneSnapshots(sessionId: string, keepCurrent: string): Promise<void> {
    if (!oid.test(keepCurrent))
      throw new ControlFailure('invalid_request', 'Invalid snapshot commit.')
    const prefix = this.#ref(sessionId)
    const paths = await this.#sessionPaths(sessionId)
    if (paths.length === 0)
      throw new ControlFailure(
        'managed_worktree_missing',
        'Managed worktree is missing or relocated.',
      )
    const kept = `${prefix}/snapshots/${keepCurrent}`
    for (const cwd of paths) {
      const refs = await this.#run(cwd, [
        'for-each-ref',
        '--format=%(refname)',
        `${prefix}/snapshots/`,
      ])
      for (const line of refs.split('\n')) {
        const name = line.trim()
        if (!name.startsWith(`${prefix}/snapshots/`) || name === kept) continue
        await this.#run(cwd, ['update-ref', '-d', name])
      }
    }
  }

  /** Worktree directories owned by a session under the managed root. */
  async #sessionPaths(sessionId: string): Promise<string[]> {
    const projects = await readdir(this.rootDir, { withFileTypes: true }).catch(() => null)
    if (!projects) return []
    const paths: string[] = []
    for (const entry of projects) {
      if (!entry.isDirectory()) continue
      const candidate = join(this.rootDir, entry.name, sessionId)
      if (await stat(candidate).catch(() => null)) paths.push(candidate)
    }
    return paths
  }

  /** Main worktree of the repo a linked worktree belongs to, if discoverable. */
  async #mainRepo(worktreePath: string): Promise<string | null> {
    const list = await this.git.listWorktrees(worktreePath)
    if (!list.ok) return null
    const comparable = (path: string) =>
      process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    const others = list.value.filter(
      (worktree) => comparable(worktree.path) !== comparable(worktreePath),
    )
    return (others[0] ?? list.value[0])?.path ?? null
  }

  /** Deletes `ari/…/<sessionId>` branches left behind after worktree removal. */
  async #deleteSessionBranches(repo: string, sessionId: string): Promise<void> {
    const refs = await this.git.runPlumbing(repo, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads/ari/',
    ])
    if (!refs.ok) return
    for (const line of refs.value.stdout.split('\n')) {
      const name = line.trim()
      const short = name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : ''
      if (
        !short ||
        !name.endsWith(`/${sessionId}`) ||
        short.startsWith('-') ||
        short.includes('..') ||
        short.includes('\\') ||
        !/^[A-Za-z0-9._/-]+$/.test(short)
      )
        continue
      await this.git.runPlumbing(repo, ['branch', '-D', short])
    }
  }

  async #workspace(
    child: Session,
  ): Promise<Extract<NonNullable<Session['workspace']>, { kind: 'managed-worktree' }>> {
    const workspace = child.workspace
    if (workspace?.kind !== 'managed-worktree')
      throw new ControlFailure(
        'scope_denied',
        'Shared workspaces do not have isolated changes to integrate.',
      )
    const actual = await realpath(workspace.path).catch(() => null)
    const expected = await realpath(join(this.rootDir, child.projectId, child.id)).catch(() => null)
    if (!actual || !expected || actual !== expected)
      throw new ControlFailure(
        'managed_worktree_missing',
        'Managed worktree is missing or relocated.',
      )
    const list = await this.git.listWorktrees(actual)
    const comparable = (path: string) =>
      process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    if (
      !list.ok ||
      !list.value.some(
        (w) =>
          comparable(w.path) === comparable(actual) &&
          w.branch === `refs/heads/${workspace.branch}`,
      )
    ) {
      throw new ControlFailure(
        'managed_worktree_missing',
        'Managed worktree registration or branch changed.',
      )
    }
    return workspace
  }

  /** Latest snapshot oid for a child worktree (`refs/ari/orchestration/<id>/current`). */
  async currentSnapshot(child: Session): Promise<string> {
    const workspace = await this.#workspace(child)
    return this.snapshot(workspace.path, `${this.#ref(child.id)}/current`, workspace.baseCommit)
  }

  async diff(child: Session, patch: boolean): Promise<unknown> {
    const workspace = await this.#workspace(child)
    const currentSnapshotCommit = await this.snapshot(
      workspace.path,
      `${this.#ref(child.id)}/current`,
      workspace.baseCommit,
    )
    await this.#run(workspace.path, [
      'update-ref',
      `${this.#ref(child.id)}/snapshots/${currentSnapshotCommit}`,
      currentSnapshotCommit,
    ])
    const raw = await this.#run(workspace.path, [
      'diff',
      '--numstat',
      '-z',
      '--no-renames',
      workspace.baseCommit,
      currentSnapshotCommit,
      '--',
    ])
    const statuses = (
      await this.#run(workspace.path, [
        'diff',
        '--name-status',
        '-z',
        '--no-renames',
        workspace.baseCommit,
        currentSnapshotCommit,
        '--',
      ])
    ).split('\0')
    const statusByPath = new Map<string, string>()
    for (let i = 0; i + 1 < statuses.length; i += 2)
      statusByPath.set(statuses[i + 1]!, statuses[i]!)
    const files = raw
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const first = line.indexOf('\t')
        const second = line.indexOf('\t', first + 1)
        return {
          path: line.slice(second + 1),
          status: statusByPath.get(line.slice(second + 1)) ?? 'M',
          additions: Number(line.slice(0, first)) || 0,
          deletions: Number(line.slice(first + 1, second)) || 0,
          binary: line.startsWith('-\t'),
        }
      })
    const totals = files.reduce(
      (sum, file) => ({
        files: sum.files + 1,
        additions: sum.additions + file.additions,
        deletions: sum.deletions + file.deletions,
      }),
      { files: 0, additions: 0, deletions: 0 },
    )
    return {
      sessionId: child.id,
      baseCommit: workspace.baseCommit,
      currentSnapshotCommit,
      files,
      totals,
      ...(patch
        ? {
            patch: await this.#run(workspace.path, [
              'diff',
              '--binary',
              '--no-ext-diff',
              workspace.baseCommit,
              currentSnapshotCommit,
              '--',
            ]),
          }
        : {}),
    }
  }

  async integrate(
    parent: Session,
    cwd: string,
    child: Session,
    snapshotCommit: string,
    previous?: string,
  ): Promise<{ status: 'integrated' | 'conflict'; snapshotCommit: string; files: string[] }> {
    const workspace = await this.#workspace(child)
    if (!oid.test(snapshotCommit)) throw new ControlFailure('invalid_request', 'Invalid snapshot.')
    const selected = (
      await this.#run(cwd, [
        'rev-parse',
        '--verify',
        `${this.#ref(child.id)}/snapshots/${snapshotCommit}`,
      ])
    ).trim()
    if (selected !== snapshotCommit)
      throw new ControlFailure('scope_denied', 'Snapshot does not belong to this child.')
    for (const state of [
      'MERGE_HEAD',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
      'rebase-merge',
      'rebase-apply',
    ]) {
      const location = (await this.#run(cwd, ['rev-parse', '--git-path', state])).trim()
      if (await stat(resolve(cwd, location)).catch(() => null))
        throw new ControlFailure(
          'integration_parent_dirty',
          'Finish the active Git operation before integrating.',
        )
    }
    const parentSnapshot = await this.snapshot(cwd, `${this.#ref(parent.id)}/integration-parent`)
    const merge = await this.git.runPlumbing(
      cwd,
      [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '-z',
        `--merge-base=${previous ?? workspace.baseCommit}`,
        parentSnapshot,
        snapshotCommit,
      ],
      undefined,
      true,
    )
    if (!merge.ok) throw new ControlFailure('integration_failed', merge.error.message)
    const parts = merge.value.stdout.split('\0')
    if (merge.value.conflict) {
      const end = parts.indexOf('', 1)
      return {
        status: 'conflict',
        snapshotCommit,
        files: parts.slice(1, end < 0 ? undefined : end),
      }
    }
    const tree = parts[0]?.trim() ?? ''
    if (!oid.test(tree))
      throw new ControlFailure('integration_failed', 'Git returned an invalid merge tree.')
    const patch = await this.#run(cwd, [
      'diff',
      '--binary',
      '--no-ext-diff',
      parentSnapshot,
      tree,
      '--',
    ])
    const files = (await this.#run(cwd, ['diff', '--name-only', '-z', parentSnapshot, tree, '--']))
      .split('\0')
      .filter(Boolean)
    if (patch) {
      const scratch = await mkdtemp(join(tmpdir(), 'ari-integrate-'))
      try {
        const patchFile = join(scratch, 'changes.patch')
        await writeFile(patchFile, patch, 'utf8')
        await this.#run(cwd, ['apply', '--check', '--binary', patchFile])
        if (
          (await this.snapshot(cwd, `${this.#ref(parent.id)}/integration-check`)) !== parentSnapshot
        ) {
          throw new ControlFailure(
            'integration_parent_dirty',
            'Parent changed during integration; retry after edits settle.',
          )
        }
        await this.#run(cwd, ['apply', '--binary', patchFile])
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    }
    return { status: 'integrated', snapshotCommit, files }
  }
}
