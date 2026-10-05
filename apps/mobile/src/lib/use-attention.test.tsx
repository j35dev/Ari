// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAttention } from './use-attention'

const app = vi.hoisted(() => ({
  sessions: [],
  connection: 'connected',
  session: {
    usable: true,
    supports: vi.fn((_op: string) => true),
    query: vi.fn<(op: string, params: { cursor?: string }) => Promise<unknown>>(),
  },
}))
vi.mock('./app-state', () => ({ useApp: () => app }))

const item = (sessionId: string, updatedAt: number): object => ({ sessionId, updatedAt })
beforeEach(() => app.session.supports.mockImplementation(() => true))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('what needs the user', () => {
  it('reads every page before claiming to know, newest first', async () => {
    app.session.query.mockImplementation(async (_op, params) =>
      params.cursor === undefined
        ? { items: [item('a', 1)], nextCursor: 'next' }
        : { items: [item('b', 2)], nextCursor: null },
    )
    const { result } = renderHook(() => useAttention())
    expect(result.current.items).toEqual([])
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items?.map((entry) => entry.sessionId)).toEqual(['b', 'a'])
    expect(result.current.failure).toBeNull()
  })

  it('reports a failed read instead of an empty list', async () => {
    app.session.query.mockRejectedValue(new Error('The computer did not answer.'))
    const { result } = renderHook(() => useAttention())
    await waitFor(() => expect(result.current.failure).toBe('The computer did not answer.'))
  })

  it('refuses a page list that loops rather than trusting half of it', async () => {
    app.session.query.mockResolvedValue({ items: [item('a', 1)], nextCursor: 'same' })
    const { result } = renderHook(() => useAttention())
    await waitFor(() => expect(result.current.failure).toMatch(/incomplete/))
  })

  it('has no list at all against a desktop that cannot provide one', async () => {
    app.session.supports.mockImplementation(() => false)
    const { result } = renderHook(() => useAttention())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toBeNull()
    expect(app.session.query).not.toHaveBeenCalled()
  })
})
