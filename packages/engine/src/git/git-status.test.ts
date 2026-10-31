import { describe, expect, it } from 'vitest'
import { parseRepositoryStatus } from './git-status'
import { parseReviewFiles } from './git-review-files'

const oid = 'a'.repeat(40)
const normal = (xy: string, path: string) =>
  `1 ${xy} N... 100644 100644 100644 ${oid} ${oid} ${path}`

describe('repository status', () => {
  it('preserves file names and independent staged/unstaged changes', () => {
    const status = parseRepositoryStatus(
      [
        '# branch.head feature/review',
        `# branch.oid ${oid}`,
        '# branch.upstream origin/feature/review',
        '# branch.ab +2 -3',
        normal('MM', 'file with spaces\nand\ttabs.ts'),
        '? 日本語.txt',
        '',
      ].join('\0'),
    )
    expect(status).toMatchObject({
      branch: 'feature/review',
      headOid: oid,
      upstream: 'origin/feature/review',
      ahead: 2,
      behind: 3,
    })
    expect(status.files).toMatchObject([
      { path: 'file with spaces\nand\ttabs.ts', staged: true, unstaged: true, kind: 'modified' },
      { path: '日本語.txt', staged: false, unstaged: true, kind: 'untracked' },
    ])
  })

  it('consumes rename source records without turning them into extra files', () => {
    const status = parseRepositoryStatus(
      [
        `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 new name.ts`,
        'old name.ts',
        normal('.D', 'deleted.ts'),
        '',
      ].join('\0'),
    )
    expect(status.files).toMatchObject([
      {
        path: 'new name.ts',
        oldPath: 'old name.ts',
        kind: 'renamed',
        staged: true,
        unstaged: false,
      },
      { path: 'deleted.ts', kind: 'deleted', unstaged: true },
    ])
  })

  it('handles detached/unborn branches and conflict records', () => {
    const status = parseRepositoryStatus(
      [
        '# branch.head (detached)',
        '# branch.oid (initial)',
        `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict.ts`,
        '',
      ].join('\0'),
    )
    expect(status.branch).toBeNull()
    expect(status.headOid).toBeNull()
    expect(status.files[0]).toMatchObject({
      path: 'conflict.ts',
      kind: 'conflicted',
      staged: true,
      unstaged: true,
    })
  })

  it('ignores incomplete status records', () => {
    expect(parseRepositoryStatus('1 broken\0# branch.ab nonsense\0').files).toEqual([])
  })
})

describe('review manifests', () => {
  it('joins ordinary and binary records without splitting paths on whitespace', () => {
    const files = parseReviewFiles(
      'M\0日本語 file.ts\0A\0logo.png\0',
      '2\t1\t日本語 file.ts\0-\t-\tlogo.png\0',
      [],
    )
    expect(files).toMatchObject([
      { path: '日本語 file.ts', additions: 2, deletions: 1, binary: false },
      { path: 'logo.png', kind: 'added', additions: 0, deletions: 0, binary: true },
    ])
  })

  it('joins rename numstat records and retains index/worktree flags', () => {
    const state = parseRepositoryStatus(normal('RM', 'new.ts') + '\0').files
    const files = parseReviewFiles('R095\0old.ts\0new.ts\0', '4\t2\t\0old.ts\0new.ts\0', state)
    expect(files).toMatchObject([
      {
        path: 'new.ts',
        oldPath: 'old.ts',
        kind: 'renamed',
        additions: 4,
        deletions: 2,
        staged: true,
        unstaged: true,
      },
    ])
  })

  it('keeps untracked and conflicted status classifications', () => {
    const state = parseRepositoryStatus('? fresh.ts\0').files
    expect(parseReviewFiles('A\0fresh.ts\0', '3\t0\tfresh.ts\0', state)[0]?.kind).toBe('untracked')
  })
})
