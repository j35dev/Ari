import { describe, expect, it } from 'vitest'
import { sourceControlSchemas as schemas } from './source-control'

const oid = 'a'.repeat(40)
const id = 'b'.repeat(64)

describe('source-control contracts', () => {
  it.each(['src/app.ts', 'file with spaces.ts', '日本語.ts', 'line\nname.ts', '[name].ts'])(
    'preserves literal repository path %j',
    (path) => {
      expect(schemas.path.parse(path)).toBe(path)
    },
  )

  it.each([
    '',
    '.',
    '..',
    '../secret',
    'src/../../secret',
    '/etc/passwd',
    '\\server\\share',
    'C:\\repo\\file',
    '.git/config',
    'src\0file',
    'src\\..\\file',
  ])('rejects unsafe path %j', (path) => {
    expect(schemas.path.safeParse(path).success).toBe(false)
  })

  it.each(['HEAD', 'origin/main', 'feature/review', oid])('accepts named revision %s', (ref) => {
    expect(schemas.revision.parse(ref)).toBe(ref)
  })

  it.each(['--help', 'HEAD..main', 'HEAD:file', 'HEAD~1', 'a.lock', 'a;echo bad', 'HEAD\0'])(
    'rejects unsafe revision %j',
    (ref) => {
      expect(schemas.revision.safeParse(ref).success).toBe(false)
    },
  )

  it('keeps independent index and worktree changes on one file', () => {
    const file = schemas.file.parse({
      path: 'app.ts',
      kind: 'modified',
      additions: 2,
      deletions: 1,
      binary: false,
      staged: true,
      unstaged: true,
    })
    expect(file.staged).toBe(true)
    expect(file.unstaged).toBe(true)
  })

  it('requires the selected comparison to carry its own endpoint input', () => {
    expect(schemas.comparison.safeParse({ kind: 'commit' }).success).toBe(false)
    expect(schemas.comparison.safeParse({ kind: 'turn' }).success).toBe(false)
    expect(schemas.comparison.parse({ kind: 'commit', ref: oid })).toEqual({
      kind: 'commit',
      ref: oid,
    })
    expect(schemas.comparison.parse({ kind: 'branch' })).toEqual({ kind: 'branch' })
  })

  it('retains immutable endpoints separately from live comparison labels', () => {
    expect(
      schemas.manifest.parse({
        id,
        comparison: { kind: 'working-tree' },
        baseOid: oid,
        headOid: id,
        baseLabel: 'HEAD',
        headLabel: 'Working tree',
        branch: 'feature/review',
        live: true,
        files: [],
        truncated: false,
        checkedAt: 12,
      }),
    ).toMatchObject({ baseOid: oid, headOid: id, live: true })
  })

  it('anchors review notes to either side and rejects reversed ranges', () => {
    const note = {
      id: 'note_1',
      comparisonId: id,
      path: 'old.ts',
      side: 'old',
      startLine: 3,
      endLine: 5,
      context: '-removed()',
      text: '  Keep this guard  ',
    }
    expect(schemas.note.parse(note)).toMatchObject({ side: 'old', text: 'Keep this guard' })
    expect(schemas.note.safeParse({ ...note, endLine: 2 }).success).toBe(false)
    expect(schemas.note.safeParse({ ...note, text: '  ' }).success).toBe(false)
  })

  it.each(['https://github.com', 'https://git.example.com:8443/forgejo'])(
    'accepts explicit HTTPS instance %s',
    (instance) => {
      expect(schemas.instance.parse(instance)).toBe(instance)
    },
  )

  it.each([
    'http://github.com',
    'https://user:token@git.example.com',
    'https://git.example.com?token=secret',
    'https://git.example.com/#secret',
    'file:///tmp/repo',
  ])('rejects credential-bearing or non-HTTPS instance %s', (instance) => {
    expect(schemas.instance.safeParse(instance).success).toBe(false)
  })

  it('keeps unsupported host capabilities explicit', () => {
    expect(
      schemas.capabilities.parse({
        diff: true,
        comments: false,
        review: [],
        inlineReview: false,
        merge: ['squash'],
        draft: false,
        close: true,
      }),
    ).toMatchObject({
      comments: false,
      review: [],
      merge: ['squash'],
    })
    expect(schemas.provider.options).toContain('forgejo')
    expect(schemas.provider.options).toContain('azure-devops')
  })
})
