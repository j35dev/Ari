import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ACTIVE_SETTLE_LINGER_MS } from './session-activity'
import { useSessionActivity } from './use-session-activity'

const rpcMocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

const subscribeMock = rpcMocks.subscribe as unknown as Mock<
  (name: string, params: Record<string, unknown>, onEvent: (payload: unknown) => void) => () => void
>

type ActivityApi = ReturnType<typeof useSessionActivity>

function renderActivity(visible: readonly string[] = []): {
  api: () => ActivityApi
  fire: (payload: unknown) => void
  rerender: (visible: readonly string[]) => void
} {
  let onEvent: ((payload: unknown) => void) | undefined
  subscribeMock.mockImplementation((_name, _params, handler) => {
    onEvent = handler
    return () => undefined
  })
  const { result, rerender } = renderHook(
    ({ visible }: { visible: readonly string[] }) => useSessionActivity(visible),
    { initialProps: { visible } },
  )
  return {
    api: () => result.current,
    fire: (payload) => {
      act(() => {
        onEvent?.(payload)
      })
    },
    rerender: (next) => {
      rerender({ visible: next })
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useSessionActivity', () => {
  it('keeps the sidebar working after a reply ends until all native agents finish', () => {
    vi.useFakeTimers()
    const { api, fire } = renderActivity(['s1'])
    const native = (taskId: string, status: string, at: number) =>
      fire({
        sessionId: 's1',
        event: {
          type: 'background.task.updated',
          kind: 'subagent',
          taskId,
          status,
          at,
        },
      })
    fire({ sessionId: 's1', event: { type: 'turn.started', at: 10 } })
    native('a', 'running', 11)
    native('b', 'running', 12)
    fire({ sessionId: 's1', event: { type: 'turn.settled', stopReason: 'completed', at: 20 } })
    expect(api().activityOf('s1')).toEqual({ phase: 'working', startedAt: 11 })
    act(() => vi.advanceTimersByTime(ACTIVE_SETTLE_LINGER_MS * 2))
    expect(api().activityOf('s1')?.phase).toBe('working')
    native('a', 'completed', 21)
    expect(api().activityOf('s1')?.phase).toBe('working')
    native('b', 'completed', 22)
    expect(api().activityOf('s1')).toEqual({ phase: 'done', startedAt: null, settledAt: 22 })
    act(() => vi.advanceTimersByTime(ACTIVE_SETTLE_LINGER_MS))
    expect(api().activityOf('s1')).toBeUndefined()
  })

  it('keeps approvals visible and does not settle a live main turn when an agent finishes', () => {
    const { api, fire } = renderActivity()
    fire({ sessionId: 's1', event: { type: 'turn.started', at: 10 } })
    fire({
      sessionId: 's1',
      event: {
        type: 'background.task.updated',
        kind: 'subagent',
        taskId: 'a',
        status: 'running',
        at: 11,
      },
    })
    fire({ sessionId: 's1', event: { type: 'approval.requested' } })
    expect(api().activityOf('s1')?.phase).toBe('paused')
    fire({
      sessionId: 's1',
      event: {
        type: 'background.task.updated',
        kind: 'subagent',
        taskId: 'a',
        status: 'completed',
        at: 12,
      },
    })
    expect(api().activityOf('s1')?.phase).toBe('paused')
    fire({ sessionId: 's1', event: { type: 'approval.responded' } })
    expect(api().activityOf('s1')?.phase).toBe('working')
  })

  it('shows a native failure after the group finishes and clears it when visited', () => {
    const { api, fire } = renderActivity()
    const native = (taskId: string, status: string) =>
      fire({
        sessionId: 's1',
        event: {
          type: 'background.task.updated',
          kind: 'subagent',
          taskId,
          status,
        },
      })
    native('a', 'running')
    native('b', 'running')
    native('a', 'failed')
    expect(api().activityOf('s1')?.phase).toBe('working')
    native('b', 'completed')
    expect(api().activityOf('s1')?.phase).toBe('error')
    act(() => api().acknowledge('s1'))
    expect(api().activityOf('s1')).toBeUndefined()
  })

  it('keeps queued work through acknowledgement and settle fades until it runs or is removed', () => {
    vi.useFakeTimers()
    const { api, fire } = renderActivity(['s1'])
    fire({ sessionId: 's1', event: { type: 'turn.settled', stopReason: 'completed' } })
    fire({ sessionId: 's1', event: { type: 'message.enqueued' } })
    act(() => {
      api().acknowledge('s1')
      vi.advanceTimersByTime(ACTIVE_SETTLE_LINGER_MS)
    })
    expect(api().activityOf('s1')).toEqual({ phase: 'queued', startedAt: null, queuedCount: 1 })
    fire({ sessionId: 's1', event: { type: 'message.dequeued' } })
    expect(api().activityOf('s1')).toBeUndefined()
    fire({ sessionId: 's1', event: { type: 'turn.started', at: 30 } })
    expect(api().activityOf('s1')).toEqual({ phase: 'working', startedAt: 30 })
  })

  it.each([true, false])(
    'preserves pending messages after an error badge is cleared (visible: %s)',
    (visible) => {
      vi.useFakeTimers()
      const { api, fire } = renderActivity(visible ? ['s1'] : [])
      fire({ sessionId: 's1', event: { type: 'turn.started' } })
      fire({ sessionId: 's1', event: { type: 'message.enqueued' } })
      fire({ sessionId: 's1', event: { type: 'turn.settled', stopReason: 'error' } })
      expect(api().activityOf('s1')?.phase).toBe('error')
      act(() => {
        if (visible) vi.advanceTimersByTime(ACTIVE_SETTLE_LINGER_MS)
        else api().acknowledge('s1')
      })
      expect(api().activityOf('s1')).toEqual({ phase: 'queued', startedAt: null, queuedCount: 1 })
      act(() => {
        api().forget('s1')
      })
      expect(api().activityOf('s1')).toBeUndefined()
    },
  )
  it('keeps the lookup identity until some activity changes', () => {
    const { api, fire, rerender } = renderActivity()
    const before = api().activityOf
    rerender(['s2'])
    expect(api().activityOf).toBe(before)
    fire({ sessionId: 's1', event: { type: 'turn.started', at: 10 } })
    expect(api().activityOf).not.toBe(before)
  })

  it('folds live turn events into the sidebar overlay', () => {
    const { api, fire } = renderActivity()
    expect(api().activityOf('s1')).toBeUndefined()

    fire({ sessionId: 's1', event: { type: 'turn.started', at: 10 } })
    expect(api().activityOf('s1')).toEqual({ phase: 'working', startedAt: 10 })

    fire({ sessionId: 's1', event: { type: 'approval.requested' } })
    expect(api().activityOf('s1')?.phase).toBe('paused')

    fire({ sessionId: 's1', event: { type: 'turn.settled', stopReason: 'completed', at: 20 } })
    expect(api().activityOf('s1')?.phase).toBe('done')
  })

  it('ignores journal replay frames so a reload cannot resurrect a dead turn', () => {
    const { api, fire } = renderActivity()
    fire({
      sessionId: 's1',
      replay: true,
      event: { type: 'turn.started', at: 1 },
    })
    expect(api().activityOf('s1')).toBeUndefined()
  })

  it('keeps a background settle stuck until acknowledged', () => {
    vi.useFakeTimers()
    const { api, fire } = renderActivity(['other'])
    fire({ sessionId: 's1', event: { type: 'turn.started', at: 10 } })
    fire({ sessionId: 's1', event: { type: 'turn.settled', stopReason: 'completed', at: 20 } })
    expect(api().activityOf('s1')?.phase).toBe('done')

    // No fade timer for unseen settles: time passing changes nothing.
    act(() => {
      vi.advanceTimersByTime(ACTIVE_SETTLE_LINGER_MS * 10)
    })
    expect(api().activityOf('s1')?.phase).toBe('done')

    act(() => {
      api().acknowledge('s1')
    })
    expect(api().activityOf('s1')).toBeUndefined()
  })

  it('fades a settle for the session already on screen', () => {
    vi.useFakeTimers()
    const { api, fire } = renderActivity(['s1'])
    fire({ sessionId: 's1', event: { type: 'turn.started', at: 10 } })
    fire({ sessionId: 's1', event: { type: 'turn.settled', stopReason: 'completed', at: 20 } })
    expect(api().activityOf('s1')?.phase).toBe('done')

    act(() => {
      vi.advanceTimersByTime(ACTIVE_SETTLE_LINGER_MS)
    })
    expect(api().activityOf('s1')).toBeUndefined()
  })

  it('fades every visible pane on its own timer', () => {
    vi.useFakeTimers()
    const { api, fire, rerender } = renderActivity(['s1'])
    fire({ sessionId: 's1', event: { type: 'turn.settled', stopReason: 'completed', at: 20 } })

    // A second pane opens and settles while the first is still fading: its
    // timer must not cancel the one already running.
    rerender(['s1', 's2'])
    fire({ sessionId: 's2', event: { type: 'turn.settled', stopReason: 'completed', at: 21 } })
    expect(api().activityOf('s1')?.phase).toBe('done')
    expect(api().activityOf('s2')?.phase).toBe('done')

    act(() => {
      vi.advanceTimersByTime(ACTIVE_SETTLE_LINGER_MS)
    })
    expect(api().activityOf('s1')).toBeUndefined()
    expect(api().activityOf('s2')).toBeUndefined()
  })

  it('stops fading a settle the moment a new turn starts in that pane', () => {
    vi.useFakeTimers()
    const { api, fire } = renderActivity(['s1', 's2'])
    fire({ sessionId: 's1', event: { type: 'turn.settled', stopReason: 'completed', at: 20 } })
    fire({ sessionId: 's2', event: { type: 'turn.settled', stopReason: 'completed', at: 20 } })
    fire({ sessionId: 's1', event: { type: 'turn.started', at: 21 } })

    act(() => {
      vi.advanceTimersByTime(ACTIVE_SETTLE_LINGER_MS)
    })
    expect(api().activityOf('s1')?.phase).toBe('working')
    expect(api().activityOf('s2')).toBeUndefined()
  })

  it('a new turn supersedes a sticky settle without a visit', () => {
    vi.useFakeTimers()
    const { api, fire } = renderActivity(['other'])
    fire({ sessionId: 's1', event: { type: 'turn.settled', stopReason: 'completed', at: 20 } })
    expect(api().activityOf('s1')?.phase).toBe('done')

    fire({ sessionId: 's1', event: { type: 'turn.started', at: 30 } })
    expect(api().activityOf('s1')?.phase).toBe('working')
  })

  it('acknowledge leaves live phases alone; forget clears anything', () => {
    const { api, fire } = renderActivity(['other'])
    fire({ sessionId: 's1', event: { type: 'turn.started', at: 10 } })

    act(() => {
      api().acknowledge('s1')
    })
    expect(api().activityOf('s1')?.phase).toBe('working')

    act(() => {
      api().forget('s1')
    })
    expect(api().activityOf('s1')).toBeUndefined()
  })
})
