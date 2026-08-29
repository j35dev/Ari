import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { useSessionActivity } from './use-session-activity'

const rpcMocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

const subscribeMock = rpcMocks.subscribe as unknown as Mock<
  (name: string, params: Record<string, unknown>, onEvent: (payload: unknown) => void) => () => void
>

function renderActivity(): {
  activityOf: (id: string) => ReturnType<ReturnType<typeof useSessionActivity>['activityOf']>
  fire: (payload: unknown) => void
} {
  let onEvent: ((payload: unknown) => void) | undefined
  subscribeMock.mockImplementation((_name, _params, handler) => {
    onEvent = handler
    return () => undefined
  })
  const { result } = renderHook(() => useSessionActivity())
  return {
    activityOf: (id) => result.current.activityOf(id),
    fire: (payload) => {
      act(() => {
        onEvent?.(payload)
      })
    },
  }
}

describe('useSessionActivity', () => {
  it('folds live turn events into the sidebar overlay', () => {
    const { activityOf, fire } = renderActivity()
    expect(activityOf('s1')).toBeUndefined()

    fire({ sessionId: 's1', event: { type: 'turn.started', at: 10 } })
    expect(activityOf('s1')).toEqual({ phase: 'working', startedAt: 10 })

    fire({ sessionId: 's1', event: { type: 'approval.requested' } })
    expect(activityOf('s1')?.phase).toBe('paused')

    fire({ sessionId: 's1', event: { type: 'turn.settled', stopReason: 'completed', at: 20 } })
    expect(activityOf('s1')?.phase).toBe('done')
  })

  it('ignores journal replay frames so a reload cannot resurrect a dead turn', () => {
    const { activityOf, fire } = renderActivity()
    fire({
      sessionId: 's1',
      replay: true,
      event: { type: 'turn.started', at: 1 },
    })
    expect(activityOf('s1')).toBeUndefined()
  })
})
