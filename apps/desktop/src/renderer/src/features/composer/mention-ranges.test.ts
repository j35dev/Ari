import { describe, expect, it } from 'vitest'
import { mentionRanges } from './mention-ranges'

describe('mention-ranges', () => {
  it('finds no ranges in plain text', () => {
    expect(mentionRanges('fix the bug please')).toEqual([])
    expect(mentionRanges('')).toEqual([])
  })

  it('finds a mention at the start and after whitespace', () => {
    expect(mentionRanges('@src/app.ts look')).toEqual([{ start: 0, end: 11 }])
    expect(mentionRanges('see @README.md now')).toEqual([{ start: 4, end: 14 }])
  })

  it('finds multiple mentions in reading order', () => {
    expect(mentionRanges('@a.ts and @b.md')).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ])
  })

  it('ignores mid-word @ and emails', () => {
    expect(mentionRanges('abc@def')).toEqual([])
    expect(mentionRanges('mail me at bob@example.com')).toEqual([])
  })

  it('stops the token at whitespace and punctuation', () => {
    expect(mentionRanges('@src/app.ts, please')).toEqual([{ start: 0, end: 11 }])
    expect(mentionRanges('@a\n@b')).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ])
  })
})
