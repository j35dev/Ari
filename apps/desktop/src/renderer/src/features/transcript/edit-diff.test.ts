import { describe, expect, it } from 'vitest'
import { parseDiff } from '../diffs'
import { editArgsToDiff, editPayloadToDiff } from './edit-diff'

describe('editPayloadToDiff', () => {
  it('shapes a single replacement as a one-file unified diff', () => {
    const diff = editPayloadToDiff({
      file_path: 'src/a.ts',
      old_string: 'const a = 1',
      new_string: 'const a = 2',
    })
    expect(diff?.path).toBe('src/a.ts')
    const parsed = parseDiff(diff?.diffText ?? '')
    expect(parsed.files).toHaveLength(1)
    expect(parsed.files[0]?.path).toBe('src/a.ts')
    const lines = parsed.files[0]?.hunks.flatMap((h) => h.lines) ?? []
    expect(lines.filter((l) => l.type === 'del').map((l) => l.content)).toEqual(['const a = 1'])
    expect(lines.filter((l) => l.type === 'add').map((l) => l.content)).toEqual(['const a = 2'])
  })

  it('renders an Ari Core edits[] batch as one hunk per replacement', () => {
    const diff = editPayloadToDiff({
      path: 'src/b.ts',
      edits: [
        { oldText: 'one', newText: 'uno' },
        { oldText: 'two', newText: 'dos' },
      ],
    })
    const parsed = parseDiff(diff?.diffText ?? '')
    expect(parsed.files[0]?.hunks).toHaveLength(2)
  })

  it('renders a content-only write as additions only', () => {
    const diff = editPayloadToDiff({ path: 'src/new.ts', content: 'hello\nworld' })
    const parsed = parseDiff(diff?.diffText ?? '')
    const lines = parsed.files[0]?.hunks.flatMap((h) => h.lines) ?? []
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.type === 'add')).toBe(true)
  })

  it('returns null when nothing editable is present or the diff would flood', () => {
    expect(editPayloadToDiff({ file_path: 'src/a.ts', depth: 3 })).toBeNull()
    expect(
      editPayloadToDiff({ path: 'src/a.ts', old_string: 'x', new_string: 'y'.repeat(30000) }),
    ).toBeNull()
  })
})

describe('editArgsToDiff', () => {
  it('unwraps ACP-style envelopes', () => {
    const diff = editArgsToDiff(
      JSON.stringify({
        title: 'edit',
        input: { path: 'src/a.ts', oldText: 'a', newText: 'b' },
      }),
    )
    expect(diff?.path).toBe('src/a.ts')
    expect(parseDiff(diff?.diffText ?? '').files).toHaveLength(1)
  })
})
