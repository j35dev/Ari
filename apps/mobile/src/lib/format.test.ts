import { describe, expect, it } from 'vitest'
import { countdown, formatClock, relativeTime } from './format'

describe('formatClock', () => {
  it('shows the local clock time', () => {
    const at = new Date(2026, 4, 1, 20, 48, 0).getTime()
    expect(formatClock(at)).toMatch(/\d{1,2}:\d{2}/)
  })
})

describe('countdown', () => {
  it('rounds up to the minute and widens its units with the wait', () => {
    expect(countdown(1)).toBe('1m')
    expect(countdown(45 * 60_000)).toBe('45m')
    expect(countdown(134 * 60_000)).toBe('2h 14m')
    expect(countdown((3 * 1440 + 4 * 60 + 9) * 60_000)).toBe('3d 4h')
    expect(countdown(120 * 60_000)).toBe('2h')
    expect(countdown((19 * 1440 + 20) * 60_000)).toBe('19d')
  })
})

describe('relativeTime', () => {
  it('says just now for the current moment', () => {
    expect(relativeTime(Date.now())).toBe('just now')
  })
})
