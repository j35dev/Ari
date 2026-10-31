import type { SessionSummary, TeamRoomSummary } from '@ari/contracts/rpc'
import type { BotMood } from '@ari/ui/bot-avatar'
import type { SessionActivity } from '../session/session-activity'
import { needsYouMember, replyingMember } from './team-room'

/** A bot whose main session has been quiet this long dozes off in the roster. */
export const ASLEEP_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * A roster bot's mood, read off its main session. Live activity wins: a turn
 * waiting on an approval or an answer needs the person, a running one is
 * working (the activity does not tell streaming text from tool calls), and a
 * failed one shows until the session is visited. Otherwise a bot that has
 * spoken but not for hours is asleep.
 */
export function botMoodOf(
  activity: SessionActivity | undefined,
  session: SessionSummary | undefined,
  now: number,
): BotMood {
  if (activity?.phase === 'paused') return 'needs-you'
  if (activity?.phase === 'working') return 'working'
  if (activity?.phase === 'error') return 'error'
  if (
    session !== undefined &&
    session.messageCount > 0 &&
    now - session.updatedAt > ASLEEP_AFTER_MS
  ) {
    return 'asleep'
  }
  return 'idle'
}

/**
 * What a bot is doing right now, as the verb phrase that completes "Forge …"
 * in its chat head's status line ("is working…"). Live turns only: a settled
 * turn is finished business the transcript already told the story of, so a
 * done mark leaves the line to the bot's tagline.
 */
export function botStatusOf(activity: SessionActivity | undefined): string | null {
  if (activity?.phase === 'working') return 'is working…'
  if (activity?.phase === 'paused') {
    return activity.pauseReason === 'input' ? 'has a question for you' : 'wants your approval'
  }
  if (activity?.phase === 'error') return 'hit a problem'
  return null
}

/**
 * Moods for a room's members: the bot the round waits on is replying, the one
 * that asked for the person needs them, everyone else idles. Reads the room
 * once and answers per bot.
 */
export function roomMoodsOf(room: TeamRoomSummary): (botId: string) => BotMood {
  const replying = replyingMember(room)?.botId
  const asking = needsYouMember(room)?.botId
  return (botId) => {
    if (botId === replying) return 'replying'
    if (botId === asking) return 'needs-you'
    return 'idle'
  }
}
