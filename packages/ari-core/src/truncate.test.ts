import { describe, expect, it } from 'vitest'
import { truncateHead, truncateTail } from './truncate'

const lines = (count: number, prefix = 'l'): string =>
  Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join('\n')

describe('truncateHead', () => {
  it('passes short content through untouched', () => {
    const result = truncateHead('a\nb\nc')
    expect(result.truncated).toBe(false)
    expect(result.content).toBe('a\nb\nc')
    expect(result.totalLines).toBe(3)
  })

  it('keeps the first N lines when the line limit is hit first', () => {
    const result = truncateHead(lines(50), 10)
    expect(result.truncated).toBe(true)
    expect(result.outputLines).toBe(10)
    expect(result.totalLines).toBe(50)
    expect(result.content.split('\n').at(-1)).toBe('l10')
  })

  it('stops on the byte limit without returning a partial line', () => {
    const result = truncateHead(lines(100, 'abcdefghij'), 1000, 40)
    expect(result.truncated).toBe(true)
    expect(result.content.endsWith('\n')).toBe(false)
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(40)
    for (const line of result.content.split('\n')) {
      expect(line).toMatch(/^abcdefghij\d+$/)
    }
  })
})

describe('truncateTail', () => {
  it('keeps the last N lines where errors live', () => {
    const result = truncateTail(lines(50), 5)
    expect(result.truncated).toBe(true)
    expect(result.firstLine).toBe(46)
    expect(result.content.split('\n')).toEqual(['l46', 'l47', 'l48', 'l49', 'l50'])
  })

  it('keeps a partial tail when one line exceeds the whole byte budget', () => {
    const result = truncateTail('x'.repeat(200), 10, 50)
    expect(result.truncated).toBe(true)
    expect(result.content).toHaveLength(50)
  })

  it('respects the byte limit ahead of the line limit', () => {
    const result = truncateTail(lines(100), 100, 20)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(20)
    expect(result.content.split('\n').at(-1)).toBe('l100')
  })
})
