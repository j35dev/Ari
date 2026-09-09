import { describe, expect, it } from 'vitest'
import { FocusTimer, formatTimerRemaining, truncateTimerName } from './focus-timer'
import type { FocusTimerSnapshot } from './focus-timer'

const MIN = 60_000

describe('formatTimerRemaining', () => {
  it('uses compact units and never goes negative', () => {
    expect(formatTimerRemaining(38 * MIN)).toBe('38m')
    expect(formatTimerRemaining(65 * MIN)).toBe('1h 05m')
    expect(formatTimerRemaining(45_000)).toBe('45s')
    expect(formatTimerRemaining(-100)).toBe('0s')
  })
})

describe('truncateTimerName', () => {
  it('keeps short names and truncates long ones with …', () => {
    expect(truncateTimerName('Grind')).toBe('Grind')
    expect(truncateTimerName('a-very-long-focus-session-name')).toBe('a-very-long-focus…')
    expect(truncateTimerName('a-very-long-focus-session-name').length).toBe(18)
  })
})

describe('FocusTimer', () => {
  it('counts down from an absolute end and finishes exactly once', () => {
    const timer = new FocusTimer()
    timer.start('Grind', 25 * MIN, 1_000)
    expect(timer.status).toBe('running')
    expect(timer.remainingMs(1_000 + 5 * MIN)).toBe(20 * MIN)
    expect(timer.tick(1_000 + 25 * MIN - 1)).toBe(false)
    expect(timer.tick(1_000 + 25 * MIN)).toBe(true)
    expect(timer.status).toBe('finished')
    expect(timer.remainingMs(1_000 + 99 * MIN)).toBe(0)
    expect(timer.tick(1_000 + 99 * MIN)).toBe(false)
  })

  it('pauses and resumes without losing time', () => {
    const timer = new FocusTimer()
    timer.start('Grind', 10 * MIN, 0)
    timer.pause(2 * MIN)
    expect(timer.status).toBe('paused')
    expect(timer.remainingMs(9 * MIN)).toBe(8 * MIN)
    timer.resume(9 * MIN)
    expect(timer.status).toBe('running')
    expect(timer.remainingMs(9 * MIN + 8 * MIN)).toBe(0)
  })

  it('cancels back to idle and defaults an empty name', () => {
    const timer = new FocusTimer()
    timer.start('  ', 10 * MIN, 0)
    expect(timer.name).toBe('Focus')
    timer.cancel()
    expect(timer.status).toBe('idle')
    expect(timer.snapshot().name).toBe('')
  })

  it('restores a running timer against the current clock', () => {
    const snap: FocusTimerSnapshot = {
      status: 'running',
      name: 'Grind',
      durationMs: 25 * MIN,
      endsAt: 10_000 + 25 * MIN,
      remainingMs: 25 * MIN,
    }
    const live = FocusTimer.restore(snap, 10_000 + 5 * MIN)
    expect(live.status).toBe('running')
    expect(live.remainingMs(10_000 + 5 * MIN)).toBe(20 * MIN)
  })

  it('never resurrects a timer whose expiry passed while Ari was closed', () => {
    const snap: FocusTimerSnapshot = {
      status: 'running',
      name: 'Grind',
      durationMs: 25 * MIN,
      endsAt: 1_000,
      remainingMs: 25 * MIN,
    }
    const timer = FocusTimer.restore(snap, 1_000 + 60 * MIN)
    expect(timer.status).toBe('idle')
    expect(timer.remainingMs()).toBe(0)
  })

  it('restores paused timers frozen and drops corrupt payloads', () => {
    const paused = FocusTimer.restore(
      { status: 'paused', name: 'Grind', durationMs: 10 * MIN, endsAt: 0, remainingMs: 3 * MIN },
      99 * MIN,
    )
    expect(paused.status).toBe('paused')
    expect(paused.remainingMs(999 * MIN)).toBe(3 * MIN)
    expect(FocusTimer.restore(null).status).toBe('idle')
  })
})
