import { describe, expect, it } from 'vitest'
import { parseDiff } from './parseDiff'
import type { DiffFile } from './parseDiff'

const MULTI_FILE_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 3f2a1bc..9d4c7e2 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,5 +1,6 @@',
  " import { boot } from './boot'",
  "-import { legacy } from './legacy'",
  "+import { modern } from './modern'",
  ' ',
  "-export const VERSION = '1.0.0'",
  "+export const VERSION = '2.0.0'",
  "+export const CHANNEL = 'stable'",
  ' boot()',
  '@@ -20,3 +21,6 @@ export function main(argv: string[]): void {',
  '   const flags = parse(argv)',
  '-  run(flags)',
  '+  if (flags.watch) {',
  '+    watch(flags)',
  '+  }',
  '+  run(flags)',
  ' }',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..e69de29',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,3 @@',
  "+export const NAME = 'ari'",
  '+',
  '+export function greet(): string {',
  'diff --git a/src/legacy.ts b/src/legacy.ts',
  'deleted file mode 100644',
  'index 5c1fd3f..0000000',
  '--- a/src/legacy.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-export const OLD = true',
  '-',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 8d9f2a1..c41bb33 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
].join('\n')

/** Re-serializes the hunk regions of a parsed file back to unified diff lines. */
function serializeHunks(file: DiffFile): string[] {
  const out: string[] = []
  for (const hunk of file.hunks) {
    out.push(hunk.header)
    for (const line of hunk.lines) {
      out.push((line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ') + line.content)
    }
  }
  return out
}

describe('parseDiff', () => {
  it('parses every file of a multi-file diff', () => {
    const { files } = parseDiff(MULTI_FILE_DIFF)
    expect(files.map((f) => f.path)).toEqual([
      'src/app.ts',
      'src/new.ts',
      'src/legacy.ts',
      'assets/logo.png',
    ])
  })

  it('extracts hunk headers verbatim including trailing section context', () => {
    const { files } = parseDiff(MULTI_FILE_DIFF)
    expect(files[0]?.hunks.map((h) => h.header)).toEqual([
      '@@ -1,5 +1,6 @@',
      '@@ -20,3 +21,6 @@ export function main(argv: string[]): void {',
    ])
  })

  it('computes old/new line numbers across context, add and del lines', () => {
    const { files } = parseDiff(MULTI_FILE_DIFF)
    const first = files[0]?.hunks[0]?.lines ?? []
    expect(first).toEqual([
      { type: 'context', content: "import { boot } from './boot'", oldLineNo: 1, newLineNo: 1 },
      { type: 'del', content: "import { legacy } from './legacy'", oldLineNo: 2 },
      { type: 'add', content: "import { modern } from './modern'", newLineNo: 2 },
      { type: 'context', content: '', oldLineNo: 3, newLineNo: 3 },
      { type: 'del', content: "export const VERSION = '1.0.0'", oldLineNo: 4 },
      { type: 'add', content: "export const VERSION = '2.0.0'", newLineNo: 4 },
      { type: 'add', content: "export const CHANNEL = 'stable'", newLineNo: 5 },
      { type: 'context', content: 'boot()', oldLineNo: 5, newLineNo: 6 },
    ])
  })

  it('restarts numbering from each hunk header', () => {
    const { files } = parseDiff(MULTI_FILE_DIFF)
    const second = files[0]?.hunks[1]?.lines ?? []
    expect(second[0]).toEqual({
      type: 'context',
      content: '  const flags = parse(argv)',
      oldLineNo: 20,
      newLineNo: 21,
    })
    expect(second[1]).toEqual({ type: 'del', content: '  run(flags)', oldLineNo: 21 })
    expect(second.at(-1)).toEqual({ type: 'context', content: '}', oldLineNo: 22, newLineNo: 26 })
  })

  it('flags new, deleted and binary files', () => {
    const { files } = parseDiff(MULTI_FILE_DIFF)
    expect(files[1]).toMatchObject({ path: 'src/new.ts', isNew: true })
    expect(files[1]?.hunks[0]?.lines[0]).toEqual({
      type: 'add',
      content: "export const NAME = 'ari'",
      newLineNo: 1,
    })
    expect(files[2]).toMatchObject({ path: 'src/legacy.ts', isDeleted: true })
    expect(files[2]?.hunks[0]?.lines[0]).toEqual({
      type: 'del',
      content: 'export const OLD = true',
      oldLineNo: 1,
    })
    expect(files[3]).toMatchObject({ path: 'assets/logo.png', isBinary: true })
    expect(files[3]?.hunks).toEqual([])
  })

  it('round-trips hunk regions back to the original diff text', () => {
    const { files } = parseDiff(MULTI_FILE_DIFF)
    const chunks = MULTI_FILE_DIFF.split(/^diff --git /m).slice(1)
    expect(files).toHaveLength(chunks.length)
    files.forEach((file, i) => {
      const chunk = chunks[i]
      if (chunk === undefined) return
      const lines = chunk.split('\n')
      const firstHunk = lines.findIndex((l) => l.startsWith('@@'))
      const originalRegion = firstHunk === -1 ? [] : lines.slice(firstHunk).filter((l) => l !== '')
      expect(serializeHunks(file)).toEqual(originalRegion)
    })
  })

  it('skips "no newline at end of file" markers without corrupting numbering', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old tail',
      '\\ No newline at end of file',
      '+new tail',
    ].join('\n')
    const { files } = parseDiff(diff)
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { type: 'del', content: 'old tail', oldLineNo: 1 },
      { type: 'add', content: 'new tail', newLineNo: 1 },
    ])
  })

  it('handles omitted hunk counts (@@ -3 +3 @@)', () => {
    const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -3 +3 @@', '-a', '+b'].join('\n')
    const { files } = parseDiff(diff)
    expect(files[0]?.hunks[0]?.header).toBe('@@ -3 +3 @@')
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { type: 'del', content: 'a', oldLineNo: 3 },
      { type: 'add', content: 'b', newLineNo: 3 },
    ])
  })

  it('records rename metadata', () => {
    const diff = [
      'diff --git a/old-name.ts b/new-name.ts',
      'similarity index 92%',
      'rename from old-name.ts',
      'rename to new-name.ts',
    ].join('\n')
    const { files } = parseDiff(diff)
    expect(files[0]).toMatchObject({ path: 'new-name.ts', oldPath: 'old-name.ts' })
  })

  it('unquotes non-ascii paths and strips timestamps', () => {
    const diff = [
      'diff --git a/src/caf\\303\\251.ts b/src/caf\\303\\251.ts',
      '--- "a/src/caf\\303\\251.ts"\t2026-01-01 00:00:00.000000000 +0000',
      '+++ "b/src/caf\\303\\251.ts"',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n')
    const { files } = parseDiff(diff)
    expect(files[0]?.path).toBe('src/caf\\303\\251.ts')
    expect(files[0]?.oldPath).toBeUndefined()
  })

  it('parses CRLF input identically to LF', () => {
    expect(parseDiff(MULTI_FILE_DIFF.replace(/\n/g, '\r\n'))).toEqual(parseDiff(MULTI_FILE_DIFF))
  })

  it('tolerates bare ---/+++ blocks without a diff --git preamble', () => {
    const { files } = parseDiff(['--- a/solo.txt', '+++ b/solo.txt', '@@ -1 +1 @@', '-x', '+y'].join('\n'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'solo.txt' })
    expect(files[0]?.oldPath).toBeUndefined()
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { type: 'del', content: 'x', oldLineNo: 1 },
      { type: 'add', content: 'y', newLineNo: 1 },
    ])
  })

  it('returns an empty file list for empty or non-diff input', () => {
    expect(parseDiff('')).toEqual({ files: [] })
    expect(parseDiff('hello\nworld\n')).toEqual({ files: [] })
  })

  it('never treats diff-like content inside a hunk as structure', () => {
    const diff = [
      'diff --git a/patch-notes.md b/patch-notes.md',
      '--- a/patch-notes.md',
      '+++ b/patch-notes.md',
      '@@ -1,3 +1,3 @@',
      ' intro',
      '-diff --git a/fake b/fake',
      '+--- not-a-header',
      ' outro',
    ].join('\n')
    const { files } = parseDiff(diff)
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('patch-notes.md')
    expect(files[0]?.hunks).toHaveLength(1)
    expect(files[0]?.hunks[0]?.lines.map((l) => l.content)).toEqual([
      'intro',
      'diff --git a/fake b/fake',
      '--- not-a-header',
      'outro',
    ])
  })
})
