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
