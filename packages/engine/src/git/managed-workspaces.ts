import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
  realpath,
  stat,
  lstat,
  unlink,
  readFile,
  rename,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ControlFailure } from '@ari/contracts/agent-control'
import type { Session } from '@ari/contracts/session'
import { createLogger } from '@ari/shared/logger'
import { pathKey } from '@ari/shared/paths'
import type { ResultDiffContents, ResultDiffSelection } from '@ari/contracts/orchestration'
import { GitService } from './git-service'
import { RepositoryGit } from './repository-git'
import { parseReviewFiles } from './git-review-files'
import { branchBelongsToSession, orchestrationBranch } from './orchestration-branch'

const oid = /^[a-f0-9]{40,64}$/
const component = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const log = createLogger('engine:managed-workspaces')
const removalOptions = { recursive: true, force: true, maxRetries: 6, retryDelay: 200 } as const

/** Non-destructive snapshots and explicit three-way integration in Ari-owned worktrees. */
export class ManagedWorkspaces {
  readonly #releases = new Map<string, Promise<void>>()
  #cleanupTail: Promise<unknown> = Promise.resolve()
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
    const verifiedHead = await this.git.runPlumbing(cwd, ['rev-parse', '--verify', 'HEAD'])
    if (!verifiedHead.ok)
      throw new ControlFailure('workspace_not_git', 'Isolated sessions require a Git repository with a commit.')
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
      const head = verifiedHead.value.stdout.trim()
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
    title = '',
    frozenBase?: string,
  ): Promise<NonNullable<Session['workspace']>> {
    if (!component.test(parent.projectId))
      throw new ControlFailure('invalid_request', 'Invalid project identifier.')
    const baseRef = `${this.#ref(childId)}/base`
    if (frozenBase && !oid.test(frozenBase))
      throw new ControlFailure('invalid_request', 'Invalid frozen base snapshot.')
    const baseCommit = frozenBase ?? (await this.snapshot(cwd, baseRef))
    if (frozenBase) await this.#run(cwd, ['update-ref', baseRef, frozenBase])
    const path = join(this.rootDir, parent.projectId, childId)
    const branch = await this.#uniqueBranch(cwd, orchestrationBranch(title, childId))
    await mkdir(join(this.rootDir, parent.projectId), { recursive: true })
    const workspace = { kind: 'managed-worktree' as const, path, branch, baseRef, baseCommit }
    try {
      const result = await this.git.addWorktree(cwd, path, branch, 'create-branch', baseCommit)
      if (!result.ok) throw new Error('Worktree creation was not acknowledged.')
    } catch {
      // Git can create the checkout before failing or losing its acknowledgement.
      // The computed identity is recovery context, not proof the checkout exists.
      throw new ControlFailure(
        'uncertain_outcome',
        'Worker workspace creation may have partially completed. Inspect the preserved workspace before recovery.',
        {
          childSessionId: childId,
          projectId: parent.projectId,
          stage: 'workspace_preparing',
          workspace,
          workspacePath: path,
        },
      )
    }
    return workspace
  }

  /**
   * Removes every Ari-owned trace of a child session: the linked worktree
   * (registration and directory), its `ari/…` branch, and all refs under
   * `refs/ari/orchestration/<sessionId>/` (base, current and snapshots).
   * Missing pieces are success, so destroy paths can call it unconditionally
   * and repeat it safely.
   */
  async release(sessionId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.#ref(sessionId)
    const previous = this.#releases.get(sessionId)
    if (previous) return previous
    const task = this.#release(sessionId, signal)
    this.#releases.set(sessionId, task)
    try {
      await task
    } finally {
      if (this.#releases.get(sessionId) === task) this.#releases.delete(sessionId)
    }
  }

  async #release(sessionId: string, signal?: AbortSignal): Promise<void> {
    const prefix = this.#ref(sessionId)
    const repos = (await this.#pendingReleases())[sessionId] ?? []
    signal?.throwIfAborted()
    await this.#savePending(sessionId, repos)
    signal?.throwIfAborted()
    const paths = await this.#sessionPaths(sessionId)
    for (const path of paths) {
      signal?.throwIfAborted()
      if ((await lstat(path)).isSymbolicLink()) continue
      await this.#assertOwned(path)
      const repo = await this.#mainRepo(path)
      signal?.throwIfAborted()
      if (repo && !repos.includes(repo)) repos.push(repo)
    }
    // Keep the repository even if Git removes .git before directory removal
    // fails. A later retry must still prune its registration, branch and refs.
    signal?.throwIfAborted()
    await this.#savePending(sessionId, repos)
    for (const path of paths) {
      signal?.throwIfAborted()
      if ((await lstat(path)).isSymbolicLink()) {
        signal?.throwIfAborted()
        await unlink(path)
        continue
      }
      await this.#assertOwned(path)
      const repo = await this.#mainRepo(path)
      // Git for Windows can descend through junctions while removing a worktree.
      // Unlink them first without walking targets such as shared dependencies.
      await this.#detachLinks(path, signal)
      signal?.throwIfAborted()
      if (repo) await this.git.removeWorktree(repo, path)
      // Git can report success after dropping its registration while leaving
      // files behind. Always finish removing the directory with lock retries.
      signal?.throwIfAborted()
      await rm(path, removalOptions)
    }
    for (const repo of repos) {
      signal?.throwIfAborted()
      await this.git.runPlumbing(repo, ['worktree', 'prune'])
      signal?.throwIfAborted()
      await this.#deleteSessionBranches(repo, sessionId, signal)
      signal?.throwIfAborted()
      const refs = await this.git.runPlumbing(repo, [
        'for-each-ref',
        '--format=%(refname)',
        `${prefix}/`,
      ])
      if (!refs.ok) continue
      for (const line of refs.value.stdout.split('\n')) {
        signal?.throwIfAborted()
        const name = line.trim()
        if (!name.startsWith(`${prefix}/`)) continue
        await this.git.runPlumbing(repo, ['update-ref', '-d', name])
      }
    }
    signal?.throwIfAborted()
    await this.#savePending(sessionId, null)
  }

  async #assertOwned(path: string): Promise<void> {
    const root = await realpath(this.rootDir)
    const target = await realpath(path)
    const inside = relative(root, target)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new ControlFailure('invalid_request', 'Managed workspace is outside its cleanup root.')
  }

  async #pendingReleases(): Promise<Record<string, string[]>> {
    await this.#cleanupTail
    return this.#readPending()
  }

  async #readPending(): Promise<Record<string, string[]>> {
    const raw = await readFile(join(this.rootDir, '.pending-releases.json'), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '{}'
        throw error
      },
    )
    const entries: unknown = JSON.parse(raw)
    if (!entries || typeof entries !== 'object' || Array.isArray(entries))
      throw new Error('Invalid managed workspace cleanup queue.')
    for (const [id, repos] of Object.entries(entries)) {
      if (
        !component.test(id) ||
        !Array.isArray(repos) ||
        !repos.every((repo) => typeof repo === 'string')
      )
        throw new Error('Invalid managed workspace cleanup queue entry.')
    }
    return entries as Record<string, string[]>
  }

  async #savePending(sessionId: string, repos: string[] | null): Promise<void> {
    const task = this.#cleanupTail
      .catch(() => undefined)
      .then(async () => {
        const pending = await this.#readPending()
        if (repos === null) delete pending[sessionId]
        else pending[sessionId] = repos
        if (Object.keys(pending).length === 0) {
          await rm(join(this.rootDir, '.pending-releases.json'), { force: true })
          return
        }
        await mkdir(this.rootDir, { recursive: true })
        const temporary = join(this.rootDir, '.pending-releases.json.tmp')
        await writeFile(temporary, JSON.stringify(pending), 'utf8')
        await rename(temporary, join(this.rootDir, '.pending-releases.json'))
      })
    this.#cleanupTail = task
    await task
  }

  /** Retries cleanup interrupted by locks or a previous process exit. */
  async retryReleases(
    beforeRelease?: (id: string) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return
    for (const id of Object.keys(await this.#pendingReleases())) {
      if (signal?.aborted) return
      try {
        await beforeRelease?.(id)
        if (signal?.aborted) return
        await this.release(id, signal)
      } catch (error) {
        if (signal?.aborted) return
        log.warn('managed workspace cleanup will retry on startup', {
          sessionId: id,
          error: String(error),
        })
      }
    }
  }

  /** Removes only abandoned directories; registered Git worktrees remain inspectable. */
  async sweepOrphans(
    sessionExists: (id: string) => Promise<boolean>,
    repositories: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const registered = new Set<string>()
    for (const repo of new Set(repositories)) {
      if (signal?.aborted) return
      const inside = await this.git.isRepo(repo)
      if (signal?.aborted) return
      if (!inside.ok) {
        log.warn('orphan sweep skipped repository', { repo, error: inside.error.message })
        continue
      }
      if (!inside.value) continue
      const list = await this.git.listWorktrees(repo)
      if (signal?.aborted) return
      if (!list.ok) {
        log.warn('orphan sweep skipped repository', { repo, error: list.error.message })
        continue
      }
      for (const worktree of list.value) registered.add(pathKey(worktree.path))
    }
    if (signal?.aborted) return
    const projects = await readdir(this.rootDir, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      },
    )
    for (const project of projects) {
      if (signal?.aborted) return
      if (!project.isDirectory()) continue
      const projectPath = join(this.rootDir, project.name)
      await this.#assertOwned(projectPath)
      for (const entry of await readdir(projectPath, { withFileTypes: true })) {
        if (signal?.aborted) return
        if (!entry.isDirectory() || !component.test(entry.name)) continue
        const path = join(projectPath, entry.name)
        if (registered.has(pathKey(path))) continue
        // A removed project's repository may not be in the supplied list.
        // A surviving .git marker keeps it inspectable even when Git fails.
        if (await lstat(join(path, '.git')).catch(() => null)) continue
        try {
          await this.#assertOwned(path)
          const info = await lstat(path)
          // A spawn can create its workspace before it journals the session.
          if (Date.now() - info.mtimeMs < 5 * 60_000 || (await sessionExists(entry.name))) continue
          if (signal?.aborted) return
          if (await sessionExists(entry.name)) continue
          if (signal?.aborted) return
          await this.#detachLinks(path, signal)
          if (signal?.aborted) return
          await rm(path, removalOptions)
        } catch (error) {
          if (signal?.aborted) return
          log.warn('orphaned workspace cleanup will retry on startup', {
            path,
            error: String(error),
          })
        }
      }
    }
  }

  async #detachLinks(path: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    for (const entry of await readdir(path, { withFileTypes: true })) {
      signal?.throwIfAborted()
      const child = join(path, entry.name)
      const info = await lstat(child)
      signal?.throwIfAborted()
      if (info.isSymbolicLink()) await unlink(child)
      else if (info.isDirectory()) await this.#detachLinks(child, signal)
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
    const projects = await readdir(this.rootDir, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      },
    )
    const paths: string[] = []
    for (const entry of projects) {
      if (!entry.isDirectory()) continue
      const candidate = join(this.rootDir, entry.name, sessionId)
      const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (info) paths.push(candidate)
    }
    return paths
  }

  /** Main worktree of the repo a linked worktree belongs to, if discoverable. */
  async #mainRepo(worktreePath: string): Promise<string | null> {
    const list = await this.git.listWorktrees(worktreePath)
    if (!list.ok) return null
    const others = list.value.filter((worktree) => pathKey(worktree.path) !== pathKey(worktreePath))
    return (others[0] ?? list.value[0])?.path ?? null
  }

  /** A free `ari/<title>-<key>` name. A taken name gets `-2`, `-3`, and so on. */
  async #uniqueBranch(cwd: string, preferred: string): Promise<string> {
    for (let n = 1; n <= 20; n++) {
      const branch = n === 1 ? preferred : `${preferred}-${n}`
      const taken = await this.git.runPlumbing(cwd, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ])
      if (!taken.ok) return branch
    }
    throw new ControlFailure('worktree_create_failed', 'Could not choose a free branch name.')
  }

  /** Deletes this session's `ari/…` branch, including the older id-suffixed form. */
  async #deleteSessionBranches(
    repo: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const refs = await this.git.runPlumbing(repo, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads/ari/',
    ])
    if (!refs.ok) return
    for (const line of refs.value.stdout.split('\n')) {
      signal?.throwIfAborted()
      const name = line.trim()
      const short = name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : ''
      if (
        !short ||
        !branchBelongsToSession(short, sessionId) ||
        short.startsWith('-') ||
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
    if (
      !list.ok ||
      !list.value.some(
        (w) => pathKey(w.path) === pathKey(actual) && w.branch === `refs/heads/${workspace.branch}`,
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

  async diff(child: Session, patch: boolean) {
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

  /** Read a retained result, never capturing current files or changing Git refs/index. */
  async readResultDiff(
    child: Session,
    snapshotCommit: string,
    selection: ResultDiffSelection,
    signal?: AbortSignal,
  ): Promise<ResultDiffContents> {
    const workspace = await this.#workspace(child)
    if (!oid.test(snapshotCommit) || !oid.test(workspace.baseCommit))
      throw new ControlFailure('invalid_request', 'Invalid result revision.')
    if (selection.kind === 'file' && selection.baseCommit !== workspace.baseCommit)
      throw new ControlFailure('stale_snapshot', 'The selected result base changed.')
    const git = new RepositoryGit(workspace.path)
    const run = async (args: string[], maxBytes?: number) => {
      const result = await git.run(args, { signal, maxBytes })
      if (!result.ok) throw new ControlFailure(result.error.code, result.error.message)
      return result.value
    }
    const retained = await git.run(
      [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${this.#ref(child.id)}/snapshots/${snapshotCommit}^{commit}`,
      ],
      { signal },
    )
    if (!retained.ok && retained.error.code !== 'failed')
      throw new ControlFailure(retained.error.code, retained.error.message)
    if (!retained.ok || retained.value.trim() !== snapshotCommit)
      throw new ControlFailure(
        'snapshot_unavailable',
        'The selected result snapshot is unavailable.',
      )
    const base = await git.run(
      ['rev-parse', '--verify', '--end-of-options', `${snapshotCommit}^`],
      { signal },
    )
    if (!base.ok && base.error.code !== 'failed')
      throw new ControlFailure(base.error.code, base.error.message)
    if (!base.ok)
      throw new ControlFailure('snapshot_unavailable', 'The selected result base is unavailable.')
    // Snapshots record their frozen comparison base as their parent. A changed
    // session/worktree record must never reinterpret an old result's contents.
    if (base.value.trim() !== workspace.baseCommit)
      throw new ControlFailure('stale_snapshot', 'The selected result base changed.')
    const paths =
      selection.kind === 'file'
        ? [selection.path, ...(selection.oldPath ? [selection.oldPath] : [])]
        : []
    // Literal pathspecs and the bounded runner are the same read boundary used by SCM review.
    const args = [
      '--literal-pathspecs',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--find-renames',
      workspace.baseCommit,
      snapshotCommit,
    ]
    const names = await run([...args, '--name-status', '-z', '--', ...paths])
    if (selection.kind === 'file') {
      const files = parseReviewFiles(names, '', [])
      const file = files.find((file) => file.path === selection.path)
      if (!file || files.length !== 1 || file.oldPath !== selection.oldPath)
        throw new ControlFailure(
          'invalid_file',
          'The selected file does not match this result comparison.',
        )
      return {
        kind: 'file',
        baseCommit: workspace.baseCommit,
        currentSnapshotCommit: snapshotCommit,
        path: selection.path,
        patch: await run([...args, '-U3', '--', ...paths], 1024 * 1024),
      }
    }
    const counts = await run([...args, '--numstat', '-z', '--'])
    const allFiles = parseReviewFiles(names, counts, [])
    const totals = allFiles.reduce(
      (sum, file) => ({
        files: sum.files + 1,
        additions: sum.additions + file.additions,
        deletions: sum.deletions + file.deletions,
      }),
      { files: 0, additions: 0, deletions: 0 },
    )
    return {
      kind: 'files',
      sessionId: child.id,
      baseCommit: workspace.baseCommit,
      currentSnapshotCommit: snapshotCommit,
      files: allFiles
        .slice(0, 5000)
        .map(({ path, oldPath, kind, additions, deletions, binary }) => ({
          path,
          ...(oldPath ? { oldPath } : {}),
          status: kind,
          additions,
          deletions,
          binary,
        })),
      totals,
      truncated: allFiles.length > 5000,
    }
  }

  async integrate(
    parent: Session,
    cwd: string,
    child: Session,
    snapshotCommit: string,
    previous?: string,
    expectedParentSnapshot?: string,
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
    if (expectedParentSnapshot !== undefined && parentSnapshot !== expectedParentSnapshot)
      throw new ControlFailure(
        'stale_snapshot',
        'Parent workspace changed after preview. Review a fresh preview before integrating.',
      )
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
    const files = (await this.#run(cwd, ['diff', '--name-only', '-z', parentSnapshot, tree, '--']))
      .split('\0')
      .filter(Boolean)
    if (files.length > 0) {
      const scratch = await mkdtemp(join(tmpdir(), 'ari-integrate-'))
      try {
        const patchFile = join(scratch, 'changes.patch')
        // Git writes the complete binary patch to disk without passing its
        // contents through the bounded stdout runner or a JavaScript string.
        await this.#run(cwd, [
          'diff',
          '--binary',
          '--no-ext-diff',
          '--no-textconv',
          `--output=${patchFile}`,
          parentSnapshot,
          tree,
          '--',
        ])
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
