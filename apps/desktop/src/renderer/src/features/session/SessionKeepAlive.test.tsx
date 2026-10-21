import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { SessionKeepAlive } from './SessionKeepAlive'
import { KEEP_ALIVE_LIMIT, keepAliveActions } from './session-keep-alive'

const mounts = vi.fn()
const unmounts = vi.fn()
const renders = vi.fn()

function Probe({ id, hidden }: { id: string; hidden: boolean }) {
  renders(id, hidden)
  useEffect(() => {
    mounts(id)
    return () => {
      unmounts(id)
    }
  }, [id])
  return (
    <div data-testid={`view-${id}`} data-hidden={hidden || undefined}>
      {id}
    </div>
  )
}

function pool(sessionId: string, poolId = 'pane_1') {
  return (
    <SessionKeepAlive
      key={poolId}
      poolId={poolId}
      sessionId={sessionId}
      render={(id, hidden) => <Probe id={id} hidden={hidden} />}
    />
  )
}

afterEach(() => {
  cleanup()
  act(() => keepAliveActions.reset())
  vi.clearAllMocks()
})

describe('SessionKeepAlive', () => {
  it('keeps the previous session mounted, hidden, when the pane switches', () => {
    const { rerender } = render(pool('a'))
    rerender(pool('b'))

    expect(unmounts).not.toHaveBeenCalled()
    expect(screen.getByTestId('view-a')).toHaveAttribute('data-hidden', 'true')
    expect(screen.getByTestId('view-b')).not.toHaveAttribute('data-hidden')

    // Coming back is the same instance, not a remount.
    rerender(pool('a'))
    expect(mounts).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('view-a')).not.toHaveAttribute('data-hidden')
  })

  it('does not re-render hidden views when the shell re-renders', () => {
    const { rerender } = render(pool('a'))
    rerender(pool('b'))
    renders.mockClear()

    rerender(pool('b'))

    expect(renders).toHaveBeenCalledWith('b', false)
    expect(renders).not.toHaveBeenCalledWith('a', expect.anything())
  })

  it('unmounts the least recently shown session past the limit', () => {
    const { rerender } = render(pool('s0'))
    for (let i = 1; i <= KEEP_ALIVE_LIMIT; i++) rerender(pool(`s${String(i)}`))

    expect(unmounts).toHaveBeenCalledTimes(1)
    expect(unmounts).toHaveBeenCalledWith('s0')
    expect(screen.queryByTestId('view-s0')).not.toBeInTheDocument()
  })

  it('drops a hidden copy once the session is shown in another pane', () => {
    const { rerender } = render(
      <>
        {pool('a', 'pane_1')}
        {pool('x', 'pane_2')}
      </>,
    )
    rerender(
      <>
        {pool('b', 'pane_1')}
        {pool('x', 'pane_2')}
      </>,
    )
    rerender(
      <>
        {pool('b', 'pane_1')}
        {pool('a', 'pane_2')}
      </>,
    )

    expect(screen.getAllByTestId('view-a')).toHaveLength(1)
    expect(screen.getByTestId('view-a')).not.toHaveAttribute('data-hidden')
  })

  it('unmounts sessions that no longer exist', () => {
    const { rerender } = render(pool('a'))
    rerender(pool('b'))

    act(() => keepAliveActions.keepOnly(new Set(['b'])))

    expect(unmounts).toHaveBeenCalledWith('a')
    expect(screen.queryByTestId('view-a')).not.toBeInTheDocument()
    expect(screen.getByTestId('view-b')).toBeInTheDocument()
  })
})
