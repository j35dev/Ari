import type { TeamRoomSummary } from '@ari/contracts/rpc'
import { Plus } from 'lucide-react'
import { Badge } from '@ari/ui/badge'
import { BotAvatar } from '@ari/ui/bot-avatar'
import { Button } from '@ari/ui/button'
import { SessionActivityMark } from '../moment'
import { roomMoodsOf } from './bot-mood'
import { memberCharacter } from './team-room'

export interface RoomListProps {
  rooms: readonly TeamRoomSummary[]
  /** The room on screen, highlighted the way the open session is. */
  activeRoomId: string | null
  error: string | null
  onOpenRoom: (roomId: string) => void
  onNewRoom: () => void
}

const WORKING = { phase: 'working', startedAt: null } as const

/** One room: its title, who sits in it, and whether it needs the person. */
function RoomRow({
  room,
  active,
  onOpen,
}: {
  room: TeamRoomSummary
  active: boolean
  onOpen: () => void
}) {
  const moodOf = roomMoodsOf(room)
  return (
    <div
      className={`flex items-center gap-1.5 rounded-lg px-1.5 py-1 transition-colors ${
        active ? 'bg-accent/15' : 'hover:bg-surface-2'
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        className="flex min-w-0 flex-1 flex-col rounded-md px-1 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <span className={`block truncate text-sm text-fg ${active ? 'font-medium' : ''}`}>
          {room.title}
        </span>
        <span aria-hidden="true" className="mt-0.5 flex items-center gap-1 overflow-hidden">
          {room.bots.map((bot) => (
            <BotAvatar
              key={bot.botId}
              character={memberCharacter(bot)}
              mood={moodOf(bot.botId)}
              size={18}
              className="shrink-0"
            />
          ))}
        </span>
        <span className="sr-only">{`, with ${room.bots.map((bot) => bot.name).join(', ')}`}</span>
      </button>
      {room.needsUser ? (
        <Badge tone="warning" size="sm" className="shrink-0">
          Needs you
        </Badge>
      ) : null}
      {room.round !== null ? <SessionActivityMark activity={WORKING} /> : null}
    </div>
  )
}

/** The Hive's team rooms, under the bots that sit in them. */
export function RoomList({ rooms, activeRoomId, error, onOpenRoom, onNewRoom }: RoomListProps) {
  return (
    <div className="flex max-h-[45%] min-h-0 shrink-0 flex-col border-t border-border/60 pt-1">
      <header className="flex items-center gap-2 px-3 pt-1 pb-1">
        <h2 className="min-w-0 flex-1 truncate text-2xs font-medium tracking-wide text-fg-subtle uppercase">
          Rooms
        </h2>
        <Button size="sm" variant="ghost" onClick={onNewRoom}>
          <Plus size={13} strokeWidth={2} aria-hidden="true" />
          New room
        </Button>
      </header>
      {error !== null ? (
        <p className="px-3 py-2 text-xs text-danger">{error}</p>
      ) : rooms.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-fg-subtle">
          Seat a few bots together to talk to them at once.
        </p>
      ) : (
        <div
          role="list"
          aria-label="Rooms"
          className="ari-scroll min-h-0 overflow-y-auto px-2 pb-2"
        >
          {rooms.map((room) => (
            <div key={room.id} role="listitem">
              <RoomRow
                room={room}
                active={room.id === activeRoomId}
                onOpen={() => onOpenRoom(room.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
