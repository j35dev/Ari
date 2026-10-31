import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSourceControl } from './use-source-control'
import { useReviewPreferences } from './use-review-preferences'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
const context = (branch: string) => ({
  ok: true,
  value: { status: { branch, files: [] }, refs: [], commits: [], stashes: [], turns: [] },
})
const manifest = { ok: true, value: { id: 'a'.repeat(64), files: [] } }
let invalidate: (payload: unknown) => void
beforeEach(() => {
  sessionStorage.clear()
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (method) =>
    method === 'scm.status'
      ? context('main')
      : method === 'scm.review'
        ? manifest
        : { cancelled: true },
  )
  mocks.subscribe.mockImplementation((_name, _scope, callback: typeof invalidate) => {
    invalidate = callback
    return () => undefined
  })
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('review data', () => {
  it('ignores a late old-scope result and cancels its pending request', async () => {
    let release!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      release = resolve
    })
    mocks.invoke.mockImplementation(async (method, params: { projectId?: string }) =>
      method === 'scm.status' ? (params.projectId === 'a' ? pending : context('b')) : manifest,
    )
    const { result, rerender } = renderHook(
      ({ id }) => useSourceControl({ projectId: id }, { kind: 'working-tree' }),
      { initialProps: { id: 'a' } },
    )
    rerender({ id: 'b' })
    await waitFor(() => expect(result.current.context?.status.branch).toBe('b'))
    await act(async () => {
      release(context('a'))
      await pending
    })
    expect(result.current.context?.status.branch).toBe('b')
    expect(mocks.invoke.mock.calls.some(([method]) => method === 'scm.cancel')).toBe(true)
  })

  it('coalesces invalidations while a read is pending and exposes watcher errors', async () => {
    let release!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      release = resolve
    })
    let calls = 0
    mocks.invoke.mockImplementation(async (method) =>
      method === 'scm.status' ? (++calls === 1 ? pending : context('updated')) : manifest,
    )
    const { result } = renderHook(() =>
      useSourceControl({ projectId: 'p' }, { kind: 'working-tree' }),
    )
    act(() => {
      for (let i = 0; i < 20; i++) invalidate({})
    })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(calls).toBe(1)
    await act(async () => {
      release(context('main'))
      await pending
    })
    await waitFor(() => expect(result.current.context?.status.branch).toBe('updated'))
    expect(calls).toBe(2)
    act(() => invalidate({ error: 'watch unavailable' }))
    expect(result.current.watchError).toBe('watch unavailable')
  })

  it('reads a cheap file count for the titlebar without opening a review', async () => {
    mocks.invoke.mockImplementation(async (method) =>
      method === 'scm.summary'
        ? { ok: true, value: { branch: 'main', changedFiles: 4 } }
        : { ok: false, error: { message: 'should not run' } },
    )
    const { result } = renderHook(() => useSourceControl({ projectId: 'p' }, 'summary'))
    await waitFor(() => expect(result.current.summary?.changedFiles).toBe(4))
    expect(result.current.context).toBeNull()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).toHaveBeenCalledWith(
      'scm.summary',
      expect.objectContaining({ projectId: 'p' }),
    )
  })

  it('keeps query errors explicit and supports status-only titlebar reads', async () => {
    mocks.invoke.mockImplementation(async (method) =>
      method === 'scm.status'
        ? context('main')
        : { ok: false, error: { message: 'checkpoint unavailable' } },
    )
    const { result, rerender } = renderHook(
      ({ review }) => useSourceControl({ projectId: 'p' }, review ? { kind: 'session' } : null),
      { initialProps: { review: true } },
    )
    await waitFor(() => expect(result.current.error).toBe('checkpoint unavailable'))
    const before = mocks.invoke.mock.calls.filter(([method]) => method === 'scm.review').length
    rerender({ review: false })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.manifest).toBeNull()
    expect(mocks.invoke.mock.calls.filter(([method]) => method === 'scm.review')).toHaveLength(
      before,
    )
  })
})

describe('review preferences', () => {
  it('persists comparison, literal path and scroll per session without cross-scope leakage', () => {
    const { result, rerender, unmount } = renderHook(({ scope }) => useReviewPreferences(scope), {
      initialProps: { scope: 'a' },
    })
    act(() => {
      result.current.change({ comparison: { kind: 'staged' }, path: '__proto__' })
      result.current.recordScroll('__proto__', 120)
    })
    rerender({ scope: 'b' })
    expect(result.current.value.path).toBeNull()
    rerender({ scope: 'a' })
    expect(result.current.value.comparison.kind).toBe('staged')
    expect(result.current.offset('__proto__')).toBe(120)
    unmount()
    const restored = renderHook(() => useReviewPreferences('a'))
    expect(restored.result.current.value.path).toBe('__proto__')
    restored.unmount()
  })
})
