import { describe, expect, it } from 'vitest'
import {
  PASTE_DRAFT_MAX_CHARS,
  PASTE_FILE_MIN_BYTES,
  createPasteId,
  decidePasteFile,
  pasteFilePath,
  utf8ByteLength,
} from './paste-as-file'

const SMALL = 'hello world'
const ID = 'paste-test-1'

function decide(overrides: Partial<Parameters<typeof decidePasteFile>[0]> = {}) {
  return decidePasteFile({
    pasted: SMALL,
    draft: '',
    selectionStart: 0,
    selectionEnd: 0,
    forceInline: false,
    id: ID,
    ...overrides,
  })
}

describe('decidePasteFile', () => {
  it('keeps a small paste inline', () => {
    expect(decide()).toEqual({ action: 'inline' })
  })

  it('keeps a paste just under the byte threshold inline', () => {
    expect(decide({ pasted: 'a'.repeat(PASTE_FILE_MIN_BYTES - 1) })).toEqual({ action: 'inline' })
  })

  it('turns a 32 KiB paste into a file', () => {
    const pasted = 'a'.repeat(PASTE_FILE_MIN_BYTES)
    expect(decide({ pasted })).toEqual({
      action: 'file',
      path: pasteFilePath(ID),
      content: pasted,
    })
  })

  it('counts UTF-8 bytes, not characters, for the byte threshold', () => {
    // 'é' is two UTF-8 bytes.
    const halfBytes = PASTE_FILE_MIN_BYTES / 2
    expect(utf8ByteLength('é'.repeat(halfBytes))).toBe(PASTE_FILE_MIN_BYTES)
    expect(decide({ pasted: 'é'.repeat(halfBytes) }).action).toBe('file')
    expect(decide({ pasted: 'é'.repeat(halfBytes - 1) }).action).toBe('inline')
  })

  it('turns a paste that would push the draft past the character cap into a file', () => {
    // Stay under the byte threshold so this case is the character cap alone.
    const pasted = 'b'.repeat(1000)
    const draft = 'a'.repeat(PASTE_DRAFT_MAX_CHARS - 999)
    expect(utf8ByteLength(pasted)).toBeLessThan(PASTE_FILE_MIN_BYTES)
    expect(decide({ pasted, draft })).toEqual({
      action: 'file',
      path: pasteFilePath(ID),
      content: pasted,
    })
  })

  it('keeps a paste that lands exactly at the cap inline', () => {
    const pasted = 'b'.repeat(1000)
    const draft = 'a'.repeat(PASTE_DRAFT_MAX_CHARS - 1000)
    expect(utf8ByteLength(pasted)).toBeLessThan(PASTE_FILE_MIN_BYTES)
    expect(decide({ pasted, draft })).toEqual({ action: 'inline' })
  })

  it('replaces the selection when measuring the draft after the paste', () => {
    const draft = 'a'.repeat(10) + 'tail'
    expect(decide({ pasted: SMALL, draft, selectionStart: 0, selectionEnd: 10 })).toEqual({
      action: 'inline',
    })
    const largeDraft = 'a'.repeat(PASTE_DRAFT_MAX_CHARS - SMALL.length + 1)
    expect(decide({ pasted: SMALL, draft: largeDraft }).action).toBe('file')
  })

  it('stays inline when Ctrl+Shift or Cmd+Shift bypasses the file path', () => {
    const pasted = 'a'.repeat(PASTE_FILE_MIN_BYTES * 2)
    expect(decide({ pasted, forceInline: true })).toEqual({ action: 'inline' })
  })

  it('builds the paste path under .ari/pastes with a .txt suffix', () => {
    expect(pasteFilePath('abc-123')).toBe('.ari/pastes/abc-123.txt')
  })

  it('mints a unique id per paste', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createPasteId()))
    expect(seen.size).toBe(50)
    for (const id of seen) expect(pasteFilePath(id)).toMatch(/^\.ari\/pastes\/.+\.txt$/)
  })
})
