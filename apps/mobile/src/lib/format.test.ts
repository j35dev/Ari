import { describe, expect, it } from 'vitest'
import { formatClock, relativeTime } from './format'

describe('formatClock', () => {
  it('shows the local clock time', () => {
    const at = new Date(2026, 4, 1, 20, 48, 0).getTime()
    expect(formatClock(at)).toMatch(/\d{1,2}:\d{2}/)
  })
})

describe('relativeTime', () => {
  it('says just now for the current moment', () => {
    expect(relativeTime(Date.now())).toBe('just now')
  })
})
