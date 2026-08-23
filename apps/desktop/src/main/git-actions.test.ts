import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { err, ok } from '@ari/shared/result'
import { commit, performGitAction, push, stage } from './git-actions'

let gitAvailable = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  gitAvailable = false
}

const suite = gitAvailable ? describe : describe.skip

/** Orphaned process handles can hold temp dirs briefly; delete with retries. */
async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

let dirs: string[] = []

beforeEach(() => {
  dirs = []
})

afterEach(async () => {
  await Promise.all(dirs.map((dir) => cleanup(dir)))
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function initRepo(): Promise<string> {
  const dir = await makeDir('ari-gitactions-')
  try {
    git(dir, 'init', '-b', 'main')
  } catch {
    git(dir, 'init')
  }
  git(dir, 'config', 'user.email', 'test@ari.dev')
  git(dir, 'config', 'user.name', 'Ari Tests')
  git(dir, 'config', 'core.autocrlf', 'false')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

async function seedAndCommitBase(repo: string): Promise<void> {
  await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'fixture')
}

function headSubject(repo: string): string {
  return gitOut(repo, 'log', '-1', '--format=%s').trim()
}

suite('git-actions helpers', () => {
  it('stages the requested pathspecs', async () => {
    const repo = await initRepo()
    await seedAndCommitBase(repo)
    await writeFile(join(repo, 'new.txt'), 'hello\n', 'utf8')

    await expect(stage(repo, ['new.txt'])).resolves.toEqual({ ok: true })
    expect(gitOut(repo, 'status', '--porcelain')).toMatch(/^A\s+new\.txt/)
  })

  it('refuses empty or blank pathspec lists without touching the index', async () => {
    const repo = await initRepo()
    await seedAndCommitBase(repo)
    await writeFile(join(repo, 'new.txt'), 'hello\n', 'utf8')

    const empty = await stage(repo, [])
    expect(empty).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    const blank = await stage(repo, ['   '])
    expect(blank).toMatchObject({ ok: false, error: { code: 'invalid_input' } })

    // The file stayed untracked: nothing ran.
    expect(gitOut(repo, 'status', '--porcelain')).toMatch(/^\?\? new\.txt/)
  })

  it('maps unmatched pathspecs to a command_failed result', async () => {
    const repo = await initRepo()
    await seedAndCommitBase(repo)

    const result = await stage(repo, ['does-not-exist.txt'])
    expect(result).toMatchObject({ ok: false, error: { code: 'command_failed' } })
  })

  it('commits the staged index and rejects blank messages', async () => {
    const repo = await initRepo()
    await seedAndCommitBase(repo)
    await writeFile(join(repo, 'base.txt'), 'changed\n', 'utf8')
    git(repo, 'add', '.')

    const blank = await commit(repo, '   ')
    expect(blank).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(headSubject(repo)).toBe('fixture')

    await expect(commit(repo, 'feat: real message')).resolves.toEqual({ ok: true })
    expect(headSubject(repo)).toBe('feat: real message')
    expect(gitOut(repo, 'status', '--porcelain')).toBe('')
  })

  it('fails cleanly when nothing is staged', async () => {
    const repo = await initRepo()
    await seedAndCommitBase(repo)

    const result = await commit(repo, 'nothing staged')
    expect(result).toMatchObject({ ok: false, error: { code: 'command_failed' } })
    expect(headSubject(repo)).toBe('fixture')
  })

  it('pushes HEAD to a remote and refuses option-like remotes', async () => {
    const parent = await makeDir('ari-gitpush-')
    const remotePath = join(parent, 'origin.git')
    await mkdir(remotePath)
    git(remotePath, 'init', '--bare')

    const repo = await initRepo()
    await seedAndCommitBase(repo)
    git(repo, 'remote', 'add', 'origin', remotePath)
    const branch = gitOut(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()

    const flagInjection = await push(repo, '--force')
    expect(flagInjection).toMatchObject({ ok: false, error: { code: 'invalid_input' } })

    await expect(push(repo)).resolves.toEqual({ ok: true })
    execFileSync(
      'git',
      ['--git-dir', remotePath, 'rev-parse', '--verify', `refs/heads/${branch}`],
      { stdio: 'ignore' },
    )
  })

  it('maps unreachable remotes to a command_failed result', async () => {
    const repo = await initRepo()
    await seedAndCommitBase(repo)
    git(repo, 'remote', 'add', 'origin', join(tmpdir(), 'ari-missing-remote-xyz'))

    const result = await push(repo)
    expect(result).toMatchObject({ ok: false, error: { code: 'command_failed' } })
  })
})

describe('performGitAction', () => {
  it('refuses paths that are not existing directories', async () => {
    const dir = await makeDir('ari-jail-')
    const action = () => Promise.resolve(ok(undefined))

    await expect(performGitAction(join(dir, 'nope'), action)).resolves.toEqual({
      ok: false,
      error: 'path must be an existing project directory',
    })

    const file = join(dir, 'plain.txt')
    await writeFile(file, 'x', 'utf8')
    await expect(performGitAction(file, action)).resolves.toEqual({
      ok: false,
      error: 'path must be an existing project directory',
    })
  })

  it('maps helper Results into plain IPC results', async () => {
    const dir = await makeDir('ari-map-')

    await expect(performGitAction(dir, () => Promise.resolve(ok(undefined)))).resolves.toEqual({
      ok: true,
    })
    await expect(
      performGitAction(dir, () =>
        Promise.resolve(err({ code: 'command_failed', message: 'git failed: boom' })),
      ),
    ).resolves.toEqual({ ok: false, error: 'git failed: boom' })
  })
})
