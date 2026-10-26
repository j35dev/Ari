import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from '@ari/engine/git'
import { queryTurnDiff } from './turn-diff'

const git = new GitService()
let repo: string

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

function run(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
}

/** One commit of `a.txt` and `b.txt`, then uncommitted user work on both plus an untracked note. */
async function dirtyRepo(): Promise<void> {
  repo = await mkdtemp(join(tmpdir(), 'ari-turn-diff-'))
  run('init', '-q')
  run('config', 'user.email', 'test@ari.dev')
  run('config', 'user.name', 'Ari Tests')
  run('config', 'core.autocrlf', 'false')
  run('config', 'commit.gpgsign', 'false')
  await writeFile(join(repo, 'a.txt'), 'hello\n')
  await writeFile(join(repo, 'b.txt'), 'bee\n')
  run('add', '.')
  run('commit', '-qm', 'init')
  await writeFile(join(repo, 'a.txt'), 'hello\nworld\nedited\n')
  await writeFile(join(repo, 'b.txt'), 'bee\nuser edit\n')
  await writeFile(join(repo, 'notes.txt'), 'untracked user notes\n')
}

async function capture(turnId: string): Promise<{ turnId: string; gitRef: string }> {
  const ref = await git.captureCheckpoint(repo, 'sess_1', turnId)
  if (!ref.ok || ref.value === null) throw new Error('checkpoint not captured')
  return { turnId, gitRef: ref.value }
}

function filesIn(diffText: string | null): string[] {
  return [...(diffText ?? '').matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1] ?? '')
}

describe('turn checkpoints over a dirty working tree', () => {
  it('an untouched turn shows no edits and reverts to a no-op', async () => {
    await dirtyRepo()
    const head = run('rev-parse', 'HEAD')
    const checkpoints = [await capture('turn_1')]

    const card = await queryTurnDiff(git, { path: repo, turnId: 'turn_1', checkpoints })
    expect(card).toEqual({ diffText: '' })

    expect(await git.revertToRef(repo, checkpoints[0]!.gitRef)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('hello\nworld\nedited\n')
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('bee\nuser edit\n')
    expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('untracked user notes\n')
    expect(run('rev-parse', 'HEAD')).toBe(head)
  }, 30_000)

  it('counts only the turn edits and reverts them while keeping pre-turn work', async () => {
    await dirtyRepo()
    run('add', 'b.txt')
    const head = run('rev-parse', 'HEAD')
    const checkpoints = [await capture('turn_1')]

    await writeFile(join(repo, 'a.txt'), 'agent rewrote this\n')
    await writeFile(join(repo, 'created.txt'), 'made by the agent\n')

    const card = await queryTurnDiff(git, { path: repo, turnId: 'turn_1', checkpoints })
    expect(filesIn(card.diffText).sort()).toEqual(['a.txt', 'created.txt'])

    expect((await git.revertToRef(repo, checkpoints[0]!.gitRef)).ok).toBe(true)
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('hello\nworld\nedited\n')
    expect(existsSync(join(repo, 'created.txt'))).toBe(false)
    expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('bee\nuser edit\n')
    expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('untracked user notes\n')
    expect(run('rev-parse', 'HEAD')).toBe(head)
    // The user's staged b.txt is still staged; nothing else was added to the index.
    expect(run('diff', '--cached', '--name-only')).toBe('b.txt\n')
  }, 30_000)

  it('bounds an earlier turn by the next turn checkpoint', async () => {
    await dirtyRepo()
    const first = await capture('turn_1')
    await writeFile(join(repo, 'a.txt'), 'turn one\n')
    const second = await capture('turn_2')
    await writeFile(join(repo, 'created.txt'), 'turn two\n')
    const checkpoints = [first, second]

    const one = await queryTurnDiff(git, { path: repo, turnId: 'turn_1', checkpoints })
    expect(filesIn(one.diffText)).toEqual(['a.txt'])
    const two = await queryTurnDiff(git, { path: repo, turnId: 'turn_2', checkpoints })
    expect(filesIn(two.diffText)).toEqual(['created.txt'])
  }, 30_000)

  it('reports a turn without a checkpoint as unavailable', async () => {
    await dirtyRepo()
    const result = await queryTurnDiff(git, { path: repo, turnId: 'turn_9', checkpoints: [] })
    expect(result).toEqual({ diffText: null, error: 'no checkpoint for that turn' })
  })
})
