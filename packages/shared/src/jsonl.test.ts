import { describe, expect, it } from 'vitest'
import { encodeJsonLine, parseJsonLines } from './jsonl'

describe('jsonl', () => {
  it('encodes compact single-line JSON', () => {
    expect(encodeJsonLine({ a: 1 })).toBe('{"a":1}')
  })

  it('parses well-formed lines with line numbers', () => {
    const parsed = parseJsonLines<{ n: number }>('{"n":1}\n{"n":2}\n')
    expect(parsed).toEqual([
      { kind: 'value', line: 1, value: { n: 1 }, raw: '{"n":1}' },
      { kind: 'value', line: 2, value: { n: 2 }, raw: '{"n":2}' },
    ])
  })

  it('skips blank lines but preserves numbering', () => {
    const parsed = parseJsonLines('{"a":1}\n\n   \n{"b":2}')
    expect(parsed).toEqual([
      { kind: 'value', line: 1, value: { a: 1 }, raw: '{"a":1}' },
      { kind: 'value', line: 4, value: { b: 2 }, raw: '{"b":2}' },
    ])
  })

  it('reports corrupt lines without aborting the rest', () => {
    const input = '{"good":1}\n{oops\n{"good":2}'
    const parsed = parseJsonLines(input)
    expect(parsed[0]).toEqual({ kind: 'value', line: 1, value: { good: 1 }, raw: '{"good":1}' })
    expect(parsed[1]?.kind).toBe('error')
    if (parsed[1]?.kind === 'error') {
      expect(parsed[1].line).toBe(2)
      expect(parsed[1].message.length).toBeGreaterThan(0)
      expect(parsed[1].raw).toBe('{oops')
    }
    expect(parsed[2]).toEqual({ kind: 'value', line: 3, value: { good: 2 }, raw: '{"good":2}' })
  })

  it('tolerates a truncated final line (crash during append)', () => {
    const parsed = parseJsonLines('{"ok":true}\n{"trunc')
    expect(parsed[0]?.kind).toBe('value')
    expect(parsed[1]?.kind).toBe('error')
  })
})
