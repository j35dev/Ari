import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { afterFirstPaint } from './startup-gate'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function track(promise: Promise<void>): { done: boolean } {
  const state = { done: false }
  void promise.then(() => {
    state.done = true
  })
  return state
}

describe('afterFirstPaint', () => {
  it('opens a settle delay after the window first paints', async () => {
    const window = new EventEmitter()
    const gate = track(afterFirstPaint(window, 500, 10_000))

    await vi.advanceTimersByTimeAsync(2_000)
    expect(gate.done).toBe(false)

    window.emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(499)
    expect(gate.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(gate.done).toBe(true)
  })

  it('opens on the fallback when no frame is ever reported', async () => {
    const gate = track(afterFirstPaint(new EventEmitter(), 500, 10_000))

    await vi.advanceTimersByTimeAsync(9_999)
    expect(gate.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(gate.done).toBe(true)
  })

  it('waits out the settle delay even when the frame lands near the fallback', async () => {
    const window = new EventEmitter()
    const gate = track(afterFirstPaint(window, 500, 1_000))

    await vi.advanceTimersByTimeAsync(900)
    window.emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(200)
    expect(gate.done).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    expect(gate.done).toBe(true)
  })
})
