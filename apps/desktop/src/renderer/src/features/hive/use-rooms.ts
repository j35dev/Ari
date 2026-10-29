import { useCallback, useEffect, useState } from 'react'
import type { RpcResults, TeamRoomFrame, TeamRoomSummary } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { applyRoomFrame, isRoomFrame } from './team-room'

const log = createLogger('renderer:hive')

export interface RoomCreateInput {
  title: string
  botIds: string[]
  leadBotId?: string | null
}

export interface RoomSendInput {
  roomId: string
  text: string
  /** The answer to a pick prompt: addresses this bot directly. */
  botId?: string
}

export type RoomSendResult = RpcResults['rooms.send']

export interface RoomsStore {
  rooms: readonly TeamRoomSummary[]
  /** True until the first `rooms.list` settles. */
  loading: boolean
  error: string | null
  create: (input: RoomCreateInput) => Promise<TeamRoomSummary>
  send: (input: RoomSendInput) => Promise<RoomSendResult>
  remove: (roomId: string) => Promise<boolean>
}

/**
 * The Hive's team rooms, kept live: one `rooms.list` read, then every
 * `rooms.updated` frame folded in place, so a round shows up as it runs
 * without anything polling. Off while `enabled` is false.
 */
export function useRooms(enabled = true): RoomsStore {
  const [rooms, setRooms] = useState<readonly TeamRoomSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let live = true
    // Frames that land while the list is in flight are newer than its answer,
    // so they are replayed over it rather than lost under it.
    let early: TeamRoomFrame[] | null = []
    const unsubscribe = rpc.subscribe('rooms.updated', {}, (payload) => {
      if (!live || !isRoomFrame(payload)) return
      early?.push(payload)
      setRooms((prev) => applyRoomFrame(prev, payload))
    })
    void rpc
      .invoke('rooms.list')
      .then((listed) => {
        if (!live) return
        const base: readonly TeamRoomSummary[] = Array.isArray(listed) ? listed : []
        setRooms((early ?? []).reduce((acc, frame) => applyRoomFrame(acc, frame), base))
        setError(null)
      })
      .catch((cause: unknown) => {
        if (!live) return
        log.warn('rooms.list failed', cause)
        setError('Could not load your rooms.')
      })
      .finally(() => {
        early = null
        if (live) setLoading(false)
      })
    return () => {
      live = false
      unsubscribe()
    }
  }, [enabled])

  const create = useCallback(async (input: RoomCreateInput) => {
    const room = await rpc.invoke('rooms.create', input)
    setRooms((prev) => applyRoomFrame(prev, { roomId: room.id, room }))
    return room
  }, [])

  const send = useCallback((input: RoomSendInput) => rpc.invoke('rooms.send', input), [])

  const remove = useCallback(async (roomId: string) => {
    const { removed } = await rpc.invoke('rooms.remove', { roomId })
    if (removed) setRooms((prev) => applyRoomFrame(prev, { roomId, room: null }))
    return removed
  }, [])

  return { rooms, loading, error, create, send, remove }
}
