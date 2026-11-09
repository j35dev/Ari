import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DIFF_MAX_BYTES, GitService } from '@ari/engine/git'
import { queryTurnDiff, queryTurnDiffFile } from './turn-diff'

const git = new GitService()
let repo: string

afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true })
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
  it('summarizes a large turn and loads complete files from immutable trees', async () => {
    await dirtyRepo()
    const start = await capture('turn_large')
    const first = 'first ' + 'x'.repeat(300_000) + '\n'
    const second = 'second ' + 'y'.repeat(300_000) + '\n'
    await writeFile(join(repo, 'a.txt'), first)
    await writeFile(join(repo, 'b.txt'), second)
    const end = await git.captureTurnEnd(repo, 'sess_1', 'turn_large')
    if (!end.ok || !end.value) throw new Error('end not captured')
    const card = await queryTurnDiff(git, {
      path: repo,
      turnId: start.turnId,
      checkpoints: [{ ...start, endRef: end.value }],
    })
    expect(card.error).toBeUndefined()
    expect(card.diffText).toBeNull()
    expect(card.summary?.files).toMatchObject([
      { path: 'a.txt', additions: 1, deletions: 3 },
      { path: 'b.txt', additions: 1, deletions: 2 },
    ])
    await writeFile(join(repo, 'a.txt'), 'later work\n')
    const summary = card.summary!
    const patch = await queryTurnDiffFile(repo, { ...summary, path: 'a.txt' })
    expect(filesIn(patch.diffText)).toEqual(['a.txt'])
    expect(patch.diffText).toContain('+' + first)
    expect(patch.diffText).not.toContain('later work')
    expect(patch.diffText).not.toContain(second)
  })

  it('keeps other files reviewable when one file exceeds the per-file limit', async () => {
    await dirtyRepo()
    const start = await capture('turn_large_file')
    await writeFile(join(repo, 'a.txt'), 'x'.repeat(DIFF_MAX_BYTES + 4096) + '\n')
    await writeFile(join(repo, 'b.txt'), 'small change\n')
    const card = await queryTurnDiff(git, {
      path: repo,
      turnId: start.turnId,
      checkpoints: [start],
    })
    expect(card.error).toBeUndefined()
    const summary = card.summary!
    expect(summary.files).toHaveLength(2)
    expect(await queryTurnDiffFile(repo, { ...summary, path: 'a.txt' })).toEqual({
      diffText: null,
      tooLarge: true,
    })
    const small = await queryTurnDiffFile(repo, { ...summary, path: 'b.txt' })
    expect(small.diffText).toContain('+small change')
  })

  it('pins the legacy live fallback before later work and treats pathspecs literally', async () => {
    await dirtyRepo()
    const start = await capture('turn_literal')
    await writeFile(join(repo, 'a.txt'), 'x'.repeat(DIFF_MAX_BYTES + 4096))
    const filename = '[note] with space.txt'
    await writeFile(join(repo, filename), 'original turn\n')
    const card = await queryTurnDiff(git, {
      path: repo,
      turnId: start.turnId,
      checkpoints: [start],
    })
    const summary = card.summary!
    expect(summary.files.find((file) => file.path === filename)?.additions).toBe(1)
    await writeFile(join(repo, filename), 'later turn\n')
    const patch = await queryTurnDiffFile(repo, { ...summary, path: filename })
    expect(patch.diffText).toContain('+original turn')
    expect(patch.diffText).not.toContain('later turn')
  })

  it('keeps large turn summaries and file patches inside a nested workspace', async () => {
    await dirtyRepo()
    const workspace = join(repo, 'nested')
    await mkdir(workspace)
    await writeFile(join(workspace, 'small.txt'), 'before\n')
    const captured = await git.captureCheckpoint(workspace, 'sess_1', 'turn_nested')
    if (!captured.ok || !captured.value) throw new Error('checkpoint not captured')
    await writeFile(join(workspace, 'large.txt'), 'x'.repeat(DIFF_MAX_BYTES + 4096))
    await writeFile(join(workspace, 'small.txt'), 'inside workspace\n')
    await writeFile(join(repo, 'outside.txt'), 'outside workspace\n')
    const card = await queryTurnDiff(git, {
      path: workspace,
      turnId: 'turn_nested',
      checkpoints: [{ turnId: 'turn_nested', gitRef: captured.value }],
    })
    const summary = card.summary!
    expect(summary.files.map((file) => file.path)).toEqual(['large.txt', 'small.txt'])
    const patch = await queryTurnDiffFile(workspace, { ...summary, path: 'small.txt' })
    expect(patch.diffText).toContain('+inside workspace')
    expect(patch.diffText).not.toContain('outside workspace')
  })

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
  })

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
  })

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
  })

  it('leaves a turn without a checkpoint silent even when other turns have one', async () => {
    await dirtyRepo()
    const checkpoints = [await capture('turn_1')]
    const result = await queryTurnDiff(git, { path: repo, turnId: 'turn_9', checkpoints })
    expect(result).toEqual({ diffText: null })
  })

  it('leaves a non-repository workspace silent when checkpoint capture is skipped', async () => {
    repo = await mkdtemp(join(tmpdir(), 'ari-turn-diff-'))
    expect(await git.captureCheckpoint(repo, 'sess_1', 'turn_1')).toEqual({
      ok: true,
      value: null,
    })
    expect(await queryTurnDiff(git, { path: repo, turnId: 'turn_1', checkpoints: [] })).toEqual({
      diffText: null,
    })
  })

  it.each([{}, { endRef: 'refs/ari/sess_1/end' }, { endError: 'end capture failed' }])(
    'leaves a non-repository workspace silent even with an old checkpoint: %j',
    async (end) => {
      repo = await mkdtemp(join(tmpdir(), 'ari-turn-diff-'))
      expect(
        await queryTurnDiff(git, {
          path: repo,
          turnId: 'turn_1',
          checkpoints: [{ turnId: 'turn_1', gitRef: 'refs/ari/sess_1/turn_1', ...end }],
        }),
      ).toEqual({ diffText: null })
    },
  )
})

describe('turn diff failures with a checkpoint', () => {
  function service() {
    return {
      isRepo: vi.fn<GitService['isRepo']>().mockResolvedValue({ ok: true, value: true }),
      worktreeTree: vi
        .fn<GitService['worktreeTree']>()
        .mockResolvedValue({ ok: true, value: 'end' }),
      diffForRef: vi.fn<GitService['diffForRef']>().mockResolvedValue({ ok: true, value: '' }),
    }
  }

  const params = {
    path: '/repo',
    turnId: 'turn_1',
    checkpoints: [{ turnId: 'turn_1', gitRef: 'start' }],
  }

  it('preserves an end capture error in a git workspace', async () => {
    const git = service()
    expect(
      await queryTurnDiff(git, {
        ...params,
        checkpoints: [{ ...params.checkpoints[0]!, endError: 'end capture failed' }],
      }),
    ).toEqual({ diffText: null, error: 'end capture failed' })
    expect(git.worktreeTree).not.toHaveBeenCalled()
    expect(git.diffForRef).not.toHaveBeenCalled()
  })

  it('preserves a diff failure between captured snapshots', async () => {
    const git = service()
    git.diffForRef.mockResolvedValue({
      ok: false,
      error: { code: 'diff_too_large', message: 'diff exceeds byte cap' },
    })
    expect(
      await queryTurnDiff(git, {
        ...params,
        checkpoints: [{ ...params.checkpoints[0]!, endRef: 'end' }],
      }),
    ).toEqual({ diffText: null, error: 'diff exceeds byte cap' })
    expect(git.diffForRef).toHaveBeenCalledWith('/repo', 'start', 'end')
    expect(git.worktreeTree).not.toHaveBeenCalled()
  })

  it('preserves a live snapshot failure for a legacy checkpoint', async () => {
    const git = service()
    git.worktreeTree.mockResolvedValue({
      ok: false,
      error: { code: 'command_failed', message: 'could not capture working tree' },
    })
    expect(await queryTurnDiff(git, params)).toEqual({
      diffText: null,
      error: 'could not capture working tree',
    })
    expect(git.diffForRef).not.toHaveBeenCalled()
  })

  it('preserves repository probe failures when a checkpoint exists', async () => {
    const git = service()
    git.isRepo.mockResolvedValue({
      ok: false,
      error: { code: 'git_missing', message: 'git is unavailable' },
    })
    expect(await queryTurnDiff(git, params)).toEqual({
      diffText: null,
      error: 'git is unavailable',
    })
    expect(git.diffForRef).not.toHaveBeenCalled()
  })
})
