import { mkdir, access, realpath, readFile, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GitService, ManagedWorkspaces } from '@ari/engine/git'
import { processEnvWithPath, resolveDetectionEnvironment } from '@ari/providers/shell-env'
import { TRIAGE_REPOSITORY_URL, type TriageContext, type TriageCase } from '@ari/contracts/triage'

const execFileP = promisify(execFile)
export class TriageSource {
  readonly git = new GitService({ timeoutMs: 120_000 })
  readonly snapshots: ManagedWorkspaces
  readonly cache: string
  constructor(
    readonly root: string,
    readonly upstream = `${TRIAGE_REPOSITORY_URL}.git`,
  ) {
    this.cache = join(root, 'source-cache')
    this.snapshots = new ManagedWorkspaces(join(root, 'snapshots'), this.git)
  }
  async run(cwd: string, args: string[]): Promise<string> {
    const { pathEnv } = await resolveDetectionEnvironment()
    const result = await this.git.runPlumbing(cwd, args, {
      ...processEnvWithPath(pathEnv),
      GIT_TERMINAL_PROMPT: '0',
    })
    if (!result.ok) throw new Error(result.error.message)
    return result.value.stdout.trim()
  }
  async ensureCache(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    if (
      !(await access(join(this.cache, '.git'))
        .then(() => true)
        .catch(() => false))
    ) {
      // Preserve any partial clone instead of deleting an unknown checkout.
      if (
        await access(this.cache)
          .then(() => true)
          .catch(() => false)
      )
        throw new Error(
          'The triage source cache is incomplete. Preserve it and choose a new profile or repair it before retrying.',
        )
      await this.run(this.root, [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        '--single-branch',
        '--branch',
        'main',
        this.upstream,
        this.cache,
      ])
    }
    if ((await this.run(this.cache, ['remote', 'get-url', 'origin'])) !== this.upstream)
      throw new Error('The triage source cache points to a different repository.')
    const exclude = join(this.cache, '.git', 'info', 'exclude')
    const rules = '\n/.ari-triage-context.json\n/.ari-triage-pr.json\n/.ari-triage-playbook.md\n'
    if (!(await readFile(exclude, 'utf8').catch(() => '')).includes('/.ari-triage-context.json'))
      await appendFile(exclude, rules, 'utf8')
  }
  async attach(path: string, revision: string, branch?: string): Promise<void> {
    if (
      await access(path)
        .then(() => true)
        .catch(() => false)
    ) {
      const worktrees = await this.git.listWorktrees(this.cache)
      if (
        !worktrees.ok ||
        !worktrees.value.some((w) => resolve(w.path).toLowerCase() === resolve(path).toLowerCase())
      )
        throw new Error('The triage checkout path is already in use.')
      if ((await this.run(path, ['rev-parse', 'HEAD'])) !== revision)
        throw new Error('The triage checkout has changed. Its work has been preserved.')
      return
    }
    await mkdir(join(path, '..'), { recursive: true })
    await this.run(
      this.cache,
      branch
        ? ['worktree', 'add', '-b', branch, path, revision]
        : ['worktree', 'add', '--detach', path, revision],
    )
  }
  async investigation(
    directory: string,
    context: TriageContext,
  ): Promise<NonNullable<TriageCase['source']>> {
    await this.ensureCache()
    let revision: string | null = null
    if (context.buildCommit && /^[a-f0-9]{40,64}$/.test(context.buildCommit)) {
      try {
        await this.run(this.cache, ['fetch', '--depth=1', 'origin', context.buildCommit])
        revision = await this.run(this.cache, ['rev-parse', 'FETCH_HEAD'])
      } catch {
        /* an unpublished dev build has no upstream commit */
      }
    }
    if (
      !revision &&
      /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(context.appVersion) &&
      context.profile !== 'Ari Dev'
    ) {
      try {
        await this.run(this.cache, [
          'fetch',
          '--depth=1',
          'origin',
          `refs/tags/v${context.appVersion}`,
        ])
        revision = await this.run(this.cache, ['rev-parse', 'FETCH_HEAD^{commit}'])
      } catch {
        /* unknown release tag */
      }
    }
    const match = revision ? 'exact' : 'approximate'
    if (!revision) {
      await this.run(this.cache, ['fetch', '--depth=1', 'origin', 'main'])
      revision = await this.run(this.cache, ['rev-parse', 'FETCH_HEAD'])
    }
    await this.attach(join(directory, 'source'), revision)
    return { revision, match }
  }
  async fix(directory: string, id: string): Promise<{ base: string; branch: string }> {
    await this.ensureCache()
    const branch = `ari-triage/${id}`
    const path = join(directory, 'fix')
    if (
      await access(path)
        .then(() => true)
        .catch(() => false)
    ) {
      const worktrees = await this.git.listWorktrees(this.cache)
      if (
        !worktrees.ok ||
        !worktrees.value.some(
          (w) =>
            resolve(w.path).toLowerCase() === resolve(path).toLowerCase() &&
            w.branch === `refs/heads/${branch}`,
        )
      )
        throw new Error('The fix checkout path is already in use.')
      return { base: await this.run(path, ['rev-parse', 'HEAD']), branch }
    }
    await this.run(this.cache, ['fetch', 'origin', 'main'])
    const base = await this.run(this.cache, ['rev-parse', 'FETCH_HEAD'])
    await this.attach(join(directory, 'fix'), base, branch)
    return { base, branch }
  }
  async assertFix(directory: string, item: TriageCase): Promise<string> {
    const path = join(directory, 'fix')
    const actual = await realpath(path)
    if (actual.toLowerCase() !== resolve(path).toLowerCase())
      throw new Error('The fix checkout moved outside its triage workspace.')
    if ((await this.run(path, ['rev-parse', '--show-toplevel'])) !== actual.replaceAll('\\', '/')) {
      // Git may preserve native separators on some builds.
      const top = await realpath(await this.run(path, ['rev-parse', '--show-toplevel']))
      if (top !== actual) throw new Error('This is not the recorded triage checkout.')
    }
    if ((await this.run(path, ['branch', '--show-current'])) !== item.fixBranch)
      throw new Error(
        'The fix branch changed. Return to the recorded triage branch before publishing.',
      )
    const common = await realpath(
      resolve(path, await this.run(path, ['rev-parse', '--git-common-dir'])),
    )
    if (common.toLowerCase() !== (await realpath(join(this.cache, '.git'))).toLowerCase())
      throw new Error('This fix is not part of the Ari source cache.')
    return path
  }
  async snapshot(directory: string, item: TriageCase): Promise<{ commit: string; tree: string }> {
    const path = await this.assertFix(directory, item)
    const commit = await this.snapshots.snapshot(
      path,
      `refs/ari/orchestration/${item.id}/triage-review`,
    )
    return { commit, tree: await this.run(path, ['rev-parse', `${commit}^{tree}`]) }
  }
  async changes(
    path: string,
    base: string,
    commit: string,
  ): Promise<{ path: string; mode: string; blob: string | null }[]> {
    const list = await this.run(path, ['diff', '--name-status', '--no-renames', '-z', base, commit])
    const fields = list.split('\0')
    if (Math.floor(fields.length / 2) > 500)
      throw new Error(
        'This fix is too large for triage publication. Split it into a smaller change.',
      )
    const entries: { path: string; mode: string; blob: string | null }[] = []
    for (let i = 0; i < fields.length - 1; i += 2) {
      const status = fields[i]!,
        name = fields[i + 1]!
      if (!name) continue
      if (name.startsWith('.ari-triage-'))
        throw new Error(
          'Triage support files cannot be published. Remove them from the source commit and verify again.',
        )
      const row = await this.run(path, ['ls-tree', status === 'D' ? base : commit, '--', name])
      const match = /^(100644|100755|120000) blob ([a-f0-9]{40,64})\t/.exec(row)
      if (!match)
        throw new Error(
          'Triage PRs currently support regular files and symbolic links; this change needs manual publication.',
        )
      entries.push({ path: name, mode: match[1]!, blob: status === 'D' ? null : match[2]! })
    }
    if (entries.length > 500)
      throw new Error(
        'This fix is too large for triage publication. Split it into a smaller change.',
      )
    return entries
  }
  async blob(path: string, oid: string): Promise<Buffer> {
    if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error('Invalid Git object.')
    const { pathEnv } = await resolveDetectionEnvironment()
    const { stdout } = await execFileP('git', ['cat-file', 'blob', oid], {
      cwd: path,
      encoding: 'buffer',
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
      env: processEnvWithPath(pathEnv),
    })
    return stdout
  }
}
