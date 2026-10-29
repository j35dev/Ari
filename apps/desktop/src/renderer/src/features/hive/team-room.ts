import type { BotCharacter } from '@ari/contracts/bot'
import type { TeamRoomFrame, TeamRoomSummary } from '@ari/contracts/rpc'
import { characterFromSeed } from '@ari/ui/bot-character'

/** One bot seated in a room, as the room summary carries it. */
export type RoomMember = TeamRoomSummary['bots'][number]

/** Matches the host's reading of a bot addressing the person (`@user`). */
const USER_MENTION = /(?<![\w@])@user(?![\w-])/i

/** True for a payload shaped like a `rooms.updated` frame. */
export function isRoomFrame(payload: unknown): payload is TeamRoomFrame {
  if (typeof payload !== 'object' || payload === null) return false
  const frame = payload as Partial<TeamRoomFrame>
  // `typeof null` is 'object' too: a removal frame passes, a missing room does not.
  return typeof frame.roomId === 'string' && typeof frame.room === 'object'
}

/**
 * Folds one live frame into the room list: a known room is replaced where it
 * sits, a removed one is dropped, and a room this list has not seen yet goes
 * first, since it is the newest.
 */
export function applyRoomFrame(
  rooms: readonly TeamRoomSummary[],
  frame: TeamRoomFrame,
): readonly TeamRoomSummary[] {
  const next = frame.room
  if (next === null) return rooms.filter((room) => room.id !== frame.roomId)
  if (!rooms.some((room) => room.id === frame.roomId)) return [next, ...rooms]
  return rooms.map((room) => (room.id === frame.roomId ? next : room))
}

/** The look a member wears: its saved character, else the one its bot id derives. */
export function memberCharacter(member: RoomMember): BotCharacter {
  return member.character ?? characterFromSeed(member.botId)
}

export function memberOf(room: TeamRoomSummary, botId: string | null): RoomMember | undefined {
  if (botId === null) return undefined
  return room.bots.find((bot) => bot.botId === botId)
}

/** The bot the running round is waiting on, if a round runs at all. */
export function replyingMember(room: TeamRoomSummary): RoomMember | undefined {
  return memberOf(room, room.round?.awaiting[0] ?? null)
}

/**
 * Who asked for the person: the newest bot line that says `@user`, else the
 * newest bot line at all. The summary only says that someone asked.
 */
export function needsYouMember(room: TeamRoomSummary): RoomMember | undefined {
  if (!room.needsUser) return undefined
  let newestBot: string | null = null
  for (let index = room.log.length - 1; index >= 0; index -= 1) {
    const entry = room.log[index]!
    if (entry.botId === null) continue
    if (USER_MENTION.test(entry.text)) return memberOf(room, entry.botId)
    newestBot ??= entry.botId
  }
  return memberOf(room, newestBot)
}

/** The status line for human messages held back while a round runs. */
export function pendingLabel(pending: number): string {
  return pending === 1
    ? '1 message waiting for the room to settle'
    : `${pending} messages waiting for the room to settle`
}

/** What a member chip inserts into the room composer to address that bot. */
export function mentionOf(name: string): string {
  return `@${name.trim()} `
}

/**
 * Puts a bot's mention over the draft's selection, spaced off a preceding
 * word so it still reads as a mention, and says where the caret lands.
 */
export function insertMention(
  draft: string,
  selection: { start: number; end: number },
  name: string,
): { text: string; caret: number } {
  const before = draft.slice(0, selection.start)
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const inserted = `${before}${lead}${mentionOf(name)}`
  return { text: `${inserted}${draft.slice(selection.end)}`, caret: inserted.length }
}

/** A bot's turn that said nothing, by the host's `(pass)` convention. */
export function isPass(text: string): boolean {
  return text.trim() === '(pass)'
}
