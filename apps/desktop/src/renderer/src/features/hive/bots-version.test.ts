import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { botsChanged, useBotsVersion } from './bots-version'

describe('bots version', () => {
  it('re-renders readers when a writer bumps', () => {
    const { result } = renderHook(() => useBotsVersion())
    expect(result.current).toBe(0)
    act(() => {
      botsChanged()
    })
    expect(result.current).toBe(1)
  })

  it('notifies several readers', () => {
    const first = renderHook(() => useBotsVersion())
    const second = renderHook(() => useBotsVersion())
    const start = first.result.current
    expect(second.result.current).toBe(start)
    act(() => {
      botsChanged()
    })
    expect(first.result.current).toBe(start + 1)
    expect(second.result.current).toBe(start + 1)
  })
})
