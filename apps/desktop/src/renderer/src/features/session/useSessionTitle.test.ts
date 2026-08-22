import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionTitle } from './useSessionTitle'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../lib/rpc', () => ({
  rpc: { invoke },
}))

function loadResult(title: string): unknown {
  return {
    session: {
      id: 'sess_1',
      projectId: 'adhoc',
      title,
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    },
    messages: [],
    activeTurnId: null,
  }
}

describe('useSessionTitle', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockImplementation((method: string) => {
      if (method === 'session.load') return Promise.resolve(loadResult('Old title'))
      if (method === 'command.dispatch') return Promise.resolve({ accepted: true })
      throw new Error(`unexpected method: ${method}`)
    })
  })

  it('loads the title from session.load on mount', async () => {
    const { result } = renderHook(() => useSessionTitle('sess_1'))
    expect(result.current.title).toBeNull()
    await waitFor(() => expect(result.current.title).toBe('Old title'))
    expect(invoke).toHaveBeenCalledWith('session.load', { sessionId: 'sess_1' })
  })

  it('keeps the title null when the load fails or the model is absent', async () => {
    invoke.mockImplementation(() => Promise.reject(new Error('engine unavailable')))
    const { result } = renderHook(() => useSessionTitle('sess_1'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('session.load', { sessionId: 'sess_1' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.title).toBeNull()

    invoke.mockResolvedValue(null)
    const missing = renderHook(() => useSessionTitle('sess_missing'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(missing.result.current.title).toBeNull()
  })

  it('rename dispatches session.update via command.dispatch and adopts the new title', async () => {
    const { result } = renderHook(() => useSessionTitle('sess_1'))
    await waitFor(() => expect(result.current.title).toBe('Old title'))

    await act(async () => {
      await result.current.rename('Renamed')
    })

    expect(invoke).toHaveBeenCalledWith('command.dispatch', {
      command: { type: 'session.update', sessionId: 'sess_1', title: 'Renamed' },
    })
    expect(result.current.title).toBe('Renamed')
  })

  it('reloads the title when sessionId changes and rename targets the new id', async () => {
    const { result, rerender } = renderHook(({ id }) => useSessionTitle(id), {
      initialProps: { id: 'sess_1' },
    })
    await waitFor(() => expect(result.current.title).toBe('Old title'))

    invoke.mockImplementation((method: string) => {
      if (method === 'session.load') return Promise.resolve(loadResult('Second'))
      if (method === 'command.dispatch') return Promise.resolve({ accepted: true })
      throw new Error(`unexpected method: ${method}`)
    })
    rerender({ id: 'sess_2' })
    await waitFor(() => expect(result.current.title).toBe('Second'))

    await act(async () => {
      await result.current.rename('Fresh')
    })
    expect(invoke).toHaveBeenCalledWith('command.dispatch', {
      command: { type: 'session.update', sessionId: 'sess_2', title: 'Fresh' },
    })
  })
})
