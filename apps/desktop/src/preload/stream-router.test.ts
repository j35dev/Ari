import { describe, expect, it, vi } from 'vitest'
import { StreamRouter } from './stream-router'

describe('StreamRouter', () => {
  it('wakes only the callbacks a frame is addressed to', () => {
    const router = new StreamRouter()
    const a = vi.fn()
    const b = vi.fn()
    router.subscribe('a', a)
    router.subscribe('b', b)

    router.dispatch({ id: 'a', name: 'session.events', payload: 1 })
    expect(a).toHaveBeenCalledWith({ id: 'a', name: 'session.events', payload: 1 })
    expect(b).not.toHaveBeenCalled()
  })

  it('fans a batched frame out as one plain frame per id', () => {
    const router = new StreamRouter()
    const a = vi.fn()
    const b = vi.fn()
    router.subscribe('a', a)
    router.subscribe('b', b)

    router.dispatch({ ids: ['a', 'b', 'gone'], name: 'session.events', payload: 2 })
    expect(a).toHaveBeenCalledWith({ id: 'a', name: 'session.events', payload: 2 })
    expect(b).toHaveBeenCalledWith({ id: 'b', name: 'session.events', payload: 2 })
  })

  it('stops delivering to a removed callback and keeps the others on that id', () => {
    const router = new StreamRouter()
    const first = vi.fn()
    const second = vi.fn()
    const removeFirst = router.subscribe('a', first)
    const removeSecond = router.subscribe('a', second)

    removeFirst()
    removeFirst()
    router.dispatch({ id: 'a', name: 'session.events', payload: 3 })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    removeSecond()
    router.dispatch({ id: 'a', name: 'session.events', payload: 4 })
    expect(second).toHaveBeenCalledTimes(1)
  })
})
