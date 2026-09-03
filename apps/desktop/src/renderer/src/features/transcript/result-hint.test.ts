import { describe, expect, it } from 'vitest'
import { resultHint } from './result-hint'

describe('resultHint', () => {
  it('reads a shell result through exit code and output size', () => {
    expect(resultHint('run', JSON.stringify({ output: 'a\nb\nc', exitCode: 0 }))).toBe('3 lines')
    expect(resultHint('run', JSON.stringify({ stdout: 'a', exit_code: 1 }))).toBe('exit 1')
    expect(resultHint('run', JSON.stringify({ output: '   ' }))).toBe('no output')
  })

  it('counts lines through bare strings and ACP content blocks', () => {
    expect(resultHint('read', '"one\\ntwo"')).toBe('2 lines')
    expect(
      resultHint(
        'read',
        JSON.stringify({ content: [{ type: 'text', text: 'a\nb' }, { type: 'text', text: 'c' }] }),
      ),
    ).toBe('3 lines')
    expect(resultHint('read', 'not json at all')).toBe('1 line')
  })

  it('counts search hits from a list or from match lines', () => {
    expect(resultHint('search', JSON.stringify({ matches: [1, 2, 3, 4] }))).toBe('4 matches')
    expect(resultHint('search', '"a.ts:4: hit"')).toBe('1 match')
    expect(resultHint('search', '""')).toBe('no matches')
  })

  it('counts listings as entries', () => {
    expect(resultHint('read', JSON.stringify({ files: ['a', 'b'] }))).toBe('2 entries')
    expect(resultHint('read', JSON.stringify({ entries: ['a'] }))).toBe('1 entry')
  })

  it('leads a failure with its own message, never a count', () => {
    expect(resultHint('run', JSON.stringify({ error: 'ENOENT: missing' }), true)).toBe(
      'ENOENT: missing',
    )
    expect(resultHint('run', JSON.stringify({ output: 'boom' }), true)).toBe('boom')
    expect(resultHint('run', '""', true)).toBe('failed')
    expect(resultHint('run', JSON.stringify({ error: 'x'.repeat(80) }), true)).toHaveLength(34)
  })

  it('says nothing where another readout already does', () => {
    expect(resultHint('edit', '"ok"')).toBeNull()
    expect(resultHint('todo', '"ok"')).toBeNull()
    expect(resultHint('read', undefined)).toBeNull()
    expect(resultHint('read', '""')).toBeNull()
  })
})
