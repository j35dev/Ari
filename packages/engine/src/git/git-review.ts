import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  GitComparison,
  GitReviewManifest,
  SourceControlError,
  SourceControlStatus,
} from '@ari/contracts/rpc'
import { err, ok, type Result } from '@ari/shared/result'
import { GitService } from './git-service'
import { RepositoryGit } from './repository-git'
import { parseRepositoryStatus } from './git-status'
import { parseReviewFiles } from './git-review-files'

export interface ReviewEndpoints {
  base?: string
  head?: string
}

/** Snapshot-backed review queries; reading changes never mutates HEAD or the user's index. */
export class GitReviewService {
  readonly git: RepositoryGit
  readonly #snapshots = new Map<string, GitReviewManifest>()
  #prefix = ''
  constructor(
    readonly cwd: string,
    readonly checkpoints = new GitService({ timeoutMs: 60_000 }),
  ) {
    this.git = new RepositoryGit(cwd)
  }

  async status(signal?: AbortSignal): Promise<Result<SourceControlStatus, SourceControlError>> {
    const raw = await this.git.run(
      ['-c', 'status.relativePaths=false', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
      { signal },
    )
    if (!raw.ok) return raw
    const prefix = await this.git.run(['rev-parse', '--show-prefix'], { signal })
    if (!prefix.ok) return prefix
    const base = prefix.value.trim()
    this.#prefix = base
    const result = parseRepositoryStatus(raw.value)
    result.files = result.files
      .filter((file) => file.path.startsWith(base))
      .map((file) => ({
        ...file,
        path: file.path.slice(base.length),
        ...(file.oldPath?.startsWith(base)
          ? { oldPath: file.oldPath.slice(base.length) }
          : { oldPath: undefined }),
      }))
    const remotes = await this.git.run(
      ['config', '--null', '--get-regexp', '^remote\\..*\\.url$'],
      { signal, allowExitOne: true },
    )
    if (!remotes.ok) return remotes
    result.remotes = remotes.value.split('\0').flatMap((record) => {
      const split = record.indexOf('\n')
      const name = /^remote\.(.+)\.url$/.exec(record.slice(0, split))?.[1]
      if (!name || split < 0) return []
      return [{ name, url: record.slice(split + 1).replace(/(https?:\/\/)[^/@\s]+@/g, '$1') }]
    })
    const paths = await this.git.run(
      [
        'rev-parse',
        '--git-path',
        'MERGE_HEAD',
        '--git-path',
        'rebase-merge',
        '--git-path',
        'rebase-apply',
        '--git-path',
        'CHERRY_PICK_HEAD',
        '--git-path',
        'REVERT_HEAD',
      ],
      { signal },
    )
    if (!paths.ok) return paths
    const operations = ['merge', 'rebase', 'rebase', 'cherry-pick', 'revert'] as const
    for (const [at, path] of paths.value.trim().split('\n').entries()) {
      if (await stat(resolve(this.cwd, path)).catch(() => null)) {
        result.operation = operations[at] ?? null
        break
      }
    }
    return ok(result)
  }

  async refs(): Promise<Result<string[], SourceControlError>> {
    const result = await this.git.run([
      'for-each-ref',
      '--count=200',
      '--format=%(refname:short)',
      'refs/heads',
      'refs/remotes',
    ])
    return result.ok ? ok(result.value.trim().split('\n').filter(Boolean)) : result
  }

  async manifest(
    comparison: GitComparison,
    endpoints: ReviewEndpoints = {},
    signal?: AbortSignal,
  ): Promise<Result<GitReviewManifest, SourceControlError>> {
    const status = await this.status(signal)
    if (!status.ok) return status
    const empty = await this.git.run(['hash-object', '-t', 'tree', '--stdin'], {
      signal,
      input: '',
    })
    if (!empty.ok) return empty
    const index = await this.git.run(['write-tree'], { signal })
    let base = endpoints.base ?? status.value.headOid ?? empty.value.trim()
    let head = endpoints.head
    let baseLabel = 'HEAD'
    let headLabel = 'Working tree'
    let live = true
    if (comparison.kind === 'unstaged') {
      if (!index.ok) return index
      base = index.value.trim()
      baseLabel = 'Index'
    } else if (comparison.kind === 'staged') {
      if (!index.ok) return index
      head = index.value.trim()
      headLabel = 'Index'
    } else if (comparison.kind === 'session' || comparison.kind === 'turn') {
      if (!endpoints.base || (comparison.kind === 'turn' && !endpoints.head))
        return err({
          code: 'unavailable',
          message: 'A stable checkpoint is not available for this selection.',
        })
      baseLabel = comparison.kind === 'session' ? 'Session start' : 'Before turn'
      headLabel = comparison.kind === 'session' ? 'Session changes' : 'After turn'
      live = !endpoints.head
    } else if (comparison.kind === 'commit') {
      const commit = await this.git.run(
        ['rev-list', '--parents', '-n', '1', comparison.ref, '--'],
        { signal },
      )
      if (!commit.ok) return commit
      const [oid, parent] = commit.value.trim().split(' ')
      if (!oid) return err({ code: 'unavailable', message: 'The selected commit is unavailable.' })
      base = parent ?? empty.value.trim()
      head = oid
      baseLabel = parent ? `Parent ${parent.slice(0, 7)}` : 'Empty tree'
      headLabel = comparison.ref
      live = false
    } else if (comparison.kind === 'branch' && status.value.headOid) {
      const refs = await this.refs()
      if (!refs.ok) return refs
      const target =
        comparison.base ??
        ['origin/main', 'origin/master', 'main', 'master'].find((ref) =>
          refs.value.includes(ref),
        ) ??
        'HEAD'
      const merged = await this.git.run(['merge-base', target, 'HEAD'], { signal })
      if (!merged.ok) return merged
      base = merged.value.trim()
      baseLabel = `Merge base · ${target}`
      headLabel = status.value.branch ?? 'HEAD'
    }
    if (!head) {
      const tree = await this.checkpoints.worktreeTree(this.cwd)
      if (!tree.ok)
        return err({
          code: tree.error.code === 'output_overflow' ? 'too-large' : 'failed',
          message: tree.error.message,
        })
      head = tree.value
    }
    const oldTree = await this.git.run(
      ['rev-parse', '--verify', '--end-of-options', `${base}^{tree}`],
      { signal },
    )
    if (!oldTree.ok) return oldTree
    const newTree = await this.git.run(
      ['rev-parse', '--verify', '--end-of-options', `${head}^{tree}`],
      { signal },
    )
    if (!newTree.ok) return newTree
    const args = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--relative',
      this.#prefix ? '--no-renames' : '--find-renames',
    ]
    const names = await this.git.run(
      [...args, '--name-status', '-z', oldTree.value.trim(), newTree.value.trim(), '--'],
      { signal },
    )
    if (!names.ok) return names
    const counts = await this.git.run(
      [...args, '--numstat', '-z', oldTree.value.trim(), newTree.value.trim(), '--'],
      { signal },
    )
    if (!counts.ok) return counts
    const allFiles = parseReviewFiles(names.value, counts.value, status.value.files)
    const id = createHash('sha256')
      .update(
        JSON.stringify([
          this.cwd,
          comparison,
          oldTree.value,
          newTree.value,
          status.value.headOid,
          index.ok ? index.value : null,
        ]),
      )
      .digest('hex')
    const manifest: GitReviewManifest = {
      id,
      comparison,
      baseOid: oldTree.value.trim(),
      headOid: newTree.value.trim(),
      baseLabel,
      headLabel,
      branch: status.value.branch,
      live,
      files: allFiles.slice(0, 5000),
      truncated: allFiles.length > 5000,
      checkedAt: Date.now(),
    }
    this.#snapshots.delete(id)
    this.#snapshots.set(id, manifest)
    if (this.#snapshots.size > 24) this.#snapshots.delete(this.#snapshots.keys().next().value!)
    return ok(manifest)
  }

  getSnapshot(id: string): GitReviewManifest | undefined {
    return this.#snapshots.get(id)
  }

  async diff(id: string, path: string, context = 3): Promise<Result<string, SourceControlError>> {
    const snapshot = this.#snapshots.get(id)
    const file = snapshot?.files.find((file) => file.path === path)
    if (!snapshot || !file)
      return err({
        code: 'stale',
        message: 'This comparison expired. Refresh changes to review it again.',
      })
    return this.git.run(
      [
        '--literal-pathspecs',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--relative',
        `-U${Math.min(1000, Math.max(0, context))}`,
        snapshot.baseOid,
        snapshot.headOid,
        '--',
        path,
        ...(file.oldPath ? [file.oldPath] : []),
      ],
      { maxBytes: 1024 * 1024 },
    )
  }
}
