import { useLayoutEffect, useRef, useState } from 'react'
import type { TeamRoomEntry, TeamRoomSummary } from '@ari/contracts/rpc'
import { Check, MessageSquare, Trash2, X } from 'lucide-react'
import { BotAvatar, type BotMood } from '@ari/ui/bot-avatar'
import { characterFromSeed } from '@ari/ui/bot-character'
import { Button } from '@ari/ui/button'
import { IconButton } from '@ari/ui/icon-button'
import { SessionActivityMark, WorkingGlyph } from '../moment'
import { MarkdownBlock } from '../transcript/MarkdownBlock'
import { pinnedAfterScroll } from '../transcript/transcript-pin'
import { roomMoodsOf } from './bot-mood'
import { RoomComposer } from './RoomComposer'
import {
  isPass,
  memberCharacter,
  memberOf,
  needsYouMember,
  pendingLabel,
  replyingMember,
  type RoomMember,
} from './team-room'
import type { RoomSendInput, RoomSendResult } from './use-rooms'

export interface RoomViewProps {
  room: TeamRoomSummary
  onSend: (input: RoomSendInput) => Promise<RoomSendResult>
  onRemove: (roomId: string) => Promise<boolean>
  /** Opens a bot's room thread the way the roster opens a session. */
  onOpenThread: (sessionId: string) => void
}

const WORKING = { phase: 'working', startedAt: null } as const

const NOTE = 'mx-auto w-full max-w-3xl rounded-lg border px-3 py-2 text-xs'

/** A member in the header: who it is, whether it leads, and whether it is replying now. */
function MemberChip({
  member,
  mood,
  lead,
  replying,
  onOpenThread,
}: {
  member: RoomMember
  mood: BotMood
  lead: boolean
  replying: boolean
  onOpenThread: () => void
}) {
  return (
    <li className="flex h-7 items-center gap-1.5 rounded-lg border border-border bg-surface-1 pr-0.5 pl-1.5">
      <BotAvatar character={memberCharacter(member)} mood={mood} size={20} />
      <span className="text-xs text-fg">{member.name}</span>
      {lead ? (
        <span className="rounded-sm bg-accent-subtle px-1 text-2xs font-medium text-fg">Lead</span>
      ) : null}
      {replying ? <SessionActivityMark activity={WORKING} /> : null}
      <button
        type="button"
        aria-label={`Open ${member.name}'s thread`}
        title="Open thread"
        onClick={onOpenThread}
        className="flex size-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <MessageSquare size={12} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </li>
  )
}

/** One transcript line: the person on the right, a bot on the left under its face. */
function EntryRow({ entry, member }: { entry: TeamRoomEntry; member: RoomMember | undefined }) {
  if (entry.botId === null) {
    return (
      <div className="my-2 flex justify-end">
        <div className="max-w-[85%] rounded-2xl border border-border/70 bg-surface-2/90 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words text-fg shadow-sm">
          {entry.text}
        </div>
      </div>
    )
  }
  const name = member?.name ?? 'A former member'
  if (isPass(entry.text)) {
    return <p className="my-2 pl-10 text-2xs text-fg-subtle">{name} passed</p>
  }
  return (
    <div className="my-3 flex gap-2.5">
      <BotAvatar
        character={member === undefined ? characterFromSeed(entry.botId) : memberCharacter(member)}
        size={30}
        className="shrink-0"
      />
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 text-xs font-medium text-fg-muted">{name}</p>
        <MarkdownBlock text={entry.text} />
      </div>
    </div>
  )
}

/**
 * A team room, full page: who sits in it, what was said, and a field to say
 * more. The host decides who answers each message; when nobody was addressed
 * and the room has no one to fall back on, the person picks.
 */
export function RoomView({ room, onSend, onRemove, onOpenThread }: RoomViewProps) {
  const [pickText, setPickText] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const lastTopRef = useRef<number | null>(null)
  // The transcript the room opened with does not animate in; lines after it do.
  const [openedWith] = useState(() => new Set(room.log.map((entry) => entry.id)))

  const replying = replyingMember(room)
  const asking = needsYouMember(room)
  const moodOf = roomMoodsOf(room)
  const running = room.round !== null
  const lastEntryId = room.log.at(-1)?.id

  // Follows the tail as lines and status arrive, unless the reader scrolled up.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null || !pinnedRef.current) return
    scroller.scrollTop = scroller.scrollHeight
  }, [lastEntryId, running, room.pending])

  const handleScroll = (): void => {
    const scroller = scrollRef.current
    if (scroller === null || scroller.clientHeight === 0) return
    const previous = lastTopRef.current
    lastTopRef.current = scroller.scrollTop
    pinnedRef.current = pinnedAfterScroll({
      wasPinned: pinnedRef.current,
      distanceFromBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      scrolledDown: previous !== null && scroller.scrollTop > previous,
      scrolledUp: previous !== null && scroller.scrollTop < previous,
    })
  }

  const send = async (text: string): Promise<void> => {
    const result = await onSend({ roomId: room.id, text })
    setPickError(null)
    setPickText(result.pick ? text : null)
  }

  const pick = (botId: string): void => {
    if (pickText === null) return
    setPickError(null)
    void onSend({ roomId: room.id, text: pickText, botId })
      .then(() => setPickText(null))
      .catch((cause: unknown) => {
        setPickError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  const remove = (): void => {
    setRemoveError(null)
    void onRemove(room.id)
      .then((removed) => {
        if (!removed) setRemoveError('This room could not be deleted.')
      })
      .catch((cause: unknown) => {
        setRemoveError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  return (
    <section aria-label={`Room ${room.title}`} className="flex h-full min-h-0 flex-col">
      <header className="flex items-start gap-3 border-b border-border/60 px-6 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-fg">{room.title}</h1>
          <ul aria-label="Members" className="mt-2 flex flex-wrap gap-1.5">
            {room.bots.map((member) => (
              <MemberChip
                key={member.botId}
                member={member}
                mood={moodOf(member.botId)}
                lead={member.botId === room.leadBotId}
                replying={member.botId === replying?.botId}
                onOpenThread={() => onOpenThread(member.sessionId)}
              />
            ))}
          </ul>
        </div>
        {confirming ? (
          <div className="flex shrink-0 items-center gap-1">
            <span className="text-2xs text-fg-muted">Delete room?</span>
            <IconButton
              size="sm"
              variant="danger"
              icon={<Check className="h-3.5 w-3.5" />}
              aria-label={`Confirm delete ${room.title}`}
              onClick={remove}
            />
            <IconButton
              size="sm"
              variant="ghost"
              icon={<X className="h-3.5 w-3.5" />}
              aria-label={`Keep ${room.title}`}
              onClick={() => setConfirming(false)}
            />
          </div>
        ) : (
          <IconButton
            size="sm"
            variant="ghost"
            icon={<Trash2 className="h-3.5 w-3.5" />}
            aria-label={`Delete ${room.title}`}
            title="Delete room"
            onClick={() => setConfirming(true)}
          />
        )}
      </header>
      {removeError !== null ? (
        <p role="alert" className="px-6 pt-2 text-xs text-danger">
          {removeError}
        </p>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Room transcript"
        className="ari-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <div className="mx-auto max-w-3xl">
          {room.log.length === 0 ? (
            <p className="py-10 text-center text-sm text-fg-subtle">
              No messages yet — say hello to the room.
            </p>
          ) : (
            room.log.map((entry) => (
              <div
                key={entry.id}
                className={openedWith.has(entry.id) ? undefined : 'ari-enter-rise'}
              >
                <EntryRow entry={entry} member={memberOf(room, entry.botId)} />
              </div>
            ))
          )}
          {running || room.pending > 0 ? (
            <div className="mt-3 flex flex-col gap-1 px-1">
              {running ? (
                <WorkingGlyph label={`${replying?.name ?? 'The room'} is replying`} />
              ) : null}
              {room.pending > 0 ? (
                <p role="status" className="text-xs text-fg-subtle">
                  {pendingLabel(room.pending)}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2 px-4 pb-4">
        {room.needsUser ? (
          <p
            role="status"
            className={`${NOTE} flex items-center gap-2 border-warning/30 bg-warning-subtle text-warning`}
          >
            {asking !== undefined ? (
              <>
                <BotAvatar character={memberCharacter(asking)} mood="needs-you" size={20} />
                {`${asking.name} needs you`}
              </>
            ) : (
              'A bot needs you'
            )}
          </p>
        ) : null}
        {pickText !== null ? (
          <div
            role="group"
            aria-label="Pick a bot"
            className={`${NOTE} flex flex-col gap-2 border-border bg-surface-1 text-fg-muted`}
          >
            <p>Nobody was addressed and the room has no lead. Who should answer?</p>
            <div className="flex flex-wrap gap-1.5">
              {room.bots.map((member) => (
                <Button
                  key={member.botId}
                  size="sm"
                  variant="secondary"
                  aria-label={`Ask ${member.name}`}
                  onClick={() => pick(member.botId)}
                >
                  <BotAvatar character={memberCharacter(member)} size={16} />
                  {member.name}
                </Button>
              ))}
            </div>
            {pickError !== null ? (
              <p role="alert" className="text-danger">
                {pickError}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="mx-auto w-full max-w-3xl">
          <RoomComposer members={room.bots} onSend={send} />
        </div>
      </div>
    </section>
  )
}
