import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { TeamRoomSummary } from '@ari/contracts/rpc'
import { roomFixture } from './room-fixture'
import { useRooms } from './use-rooms'

type Listener = (payload: unknown) => void

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(),
}))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
const invokeMock = rpcMocks.invoke as unknown as Mock
const subscribeMock = rpcMocks.subscribe as unknown as Mock

let listener: Listener | null = null
const unsubscribe = vi.fn()

function push(payload: unknown): void {
  act(() => listener?.(payload))
}

beforeEach(() => {
  invokeMock.mockReset()
  subscribeMock.mockReset()
  unsubscribe.mockReset()
  listener = null
  subscribeMock.mockImplementation((_name: string, _params: unknown, onEvent: Listener) => {
    listener = onEvent
    return unsubscribe
  })
})

describe('useRooms', () => {
  it('lists the rooms and folds live frames in place', async () => {
    invokeMock.mockResolvedValue([roomFixture()])
    const { result } = renderHook(() => useRooms())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(subscribeMock).toHaveBeenCalledWith('rooms.updated', {}, expect.any(Function))
    expect(result.current.rooms.map((room) => room.title)).toEqual(['Launch'])

    push({ roomId: 'room_1', room: roomFixture({ title: 'Launch v2' }) })
    expect(result.current.rooms.map((room) => room.title)).toEqual(['Launch v2'])

    push({ roomId: 'room_1', room: null })
    expect(result.current.rooms).toEqual([])
  })

  it('keeps a frame that lands before the list answers', async () => {
    let answer: (rooms: TeamRoomSummary[]) => void = () => undefined
    invokeMock.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const { result } = renderHook(() => useRooms())

    push({ roomId: 'room_1', room: roomFixture({ pending: 2 }) })
    await act(async () => answer([roomFixture()]))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rooms[0]?.pending).toBe(2)
  })

  it('ignores payloads that are not room frames', async () => {
    invokeMock.mockResolvedValue([roomFixture()])
    const { result } = renderHook(() => useRooms())
    await waitFor(() => expect(result.current.loading).toBe(false))

    push({ room: null })
    expect(result.current.rooms).toHaveLength(1)
  })

  it('reports a list that fails', async () => {
    invokeMock.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useRooms())

    await waitFor(() => expect(result.current.error).toBe('Could not load your rooms.'))
  })

  it('stays off until enabled, and unsubscribes on unmount', async () => {
    invokeMock.mockResolvedValue([])
    const { rerender, unmount } = renderHook(({ enabled }) => useRooms(enabled), {
      initialProps: { enabled: false },
    })
    expect(invokeMock).not.toHaveBeenCalled()
    expect(subscribeMock).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('rooms.list'))
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('adds a created room and drops a removed one without waiting for a frame', async () => {
    const created = roomFixture({ id: 'room_2', title: 'Docs' })
    invokeMock.mockImplementation(async (method: string) => {
      if (method === 'rooms.list') return [roomFixture()]
      if (method === 'rooms.create') return created
      if (method === 'rooms.remove') return { removed: true }
      return undefined
    })
    const { result } = renderHook(() => useRooms())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.create({ title: 'Docs', botIds: ['bot_a'], leadBotId: null })
    })
    expect(invokeMock).toHaveBeenCalledWith('rooms.create', {
      title: 'Docs',
      botIds: ['bot_a'],
      leadBotId: null,
    })
    expect(result.current.rooms.map((room) => room.id)).toEqual(['room_2', 'room_1'])

    await act(async () => {
      await result.current.remove('room_1')
    })
    expect(invokeMock).toHaveBeenCalledWith('rooms.remove', { roomId: 'room_1' })
    expect(result.current.rooms.map((room) => room.id)).toEqual(['room_2'])
  })
})
