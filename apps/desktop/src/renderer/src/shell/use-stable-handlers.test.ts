import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useStableHandlers } from './use-stable-handlers'

type Props = {
  title: string
  onPick?: (id: string) => string
  read: (id: string) => string
}

describe('useStableHandlers', () => {
  it('keeps on* handlers stable across renders and calls the latest one', () => {
    const first = vi.fn((id: string) => `first ${id}`)
    const second = vi.fn((id: string) => `second ${id}`)
    const read = (id: string): string => id
    const { result, rerender } = renderHook((props: Props) => useStableHandlers(props), {
      initialProps: { title: 'a', onPick: first, read },
    })
    const stablePick = result.current.onPick

    rerender({ title: 'a', onPick: second, read })

    expect(result.current.onPick).toBe(stablePick)
    expect(result.current.onPick?.('x')).toBe('second x')
    expect(first).not.toHaveBeenCalled()
  })

  it('passes data and getter props through by identity', () => {
    const readA = (id: string): string => `a ${id}`
    const readB = (id: string): string => `b ${id}`
    const { result, rerender } = renderHook((props: Props) => useStableHandlers(props), {
      initialProps: { title: 'a', read: readA },
    })
    expect(result.current.read).toBe(readA)

    rerender({ title: 'b', read: readB })

    expect(result.current.title).toBe('b')
    expect(result.current.read).toBe(readB)
  })

  it('reports an absent handler as absent', () => {
    const { result } = renderHook(() =>
      useStableHandlers<Props>({ title: 'a', onPick: undefined, read: (id) => id }),
    )
    expect(result.current.onPick).toBeUndefined()
  })
})
