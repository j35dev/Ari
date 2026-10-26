import type { Bot } from '@ari/contracts/bot'
import type { SessionSummary } from '@ari/contracts/rpc'

/**
 * Roster-shaped view of the bots on disk. Hidden bots are filtered here rather
 * than at the store: hiding is a roster affordance, and the bot keeps its
 * sessions and its main-session pointer for whenever it comes back.
 */
export function rosterOf(bots: readonly Bot[]): Bot[] {
  return bots.filter((bot) => bot.hidden !== true)
}

/** The session a bot's row opens; absent until `bots.create` sets the pointer. */
export function mainSessionOf(
  bot: Bot,
  sessions: readonly SessionSummary[],
): SessionSummary | undefined {
  if (bot.mainSessionId === undefined) return undefined
  return sessions.find((session) => session.id === bot.mainSessionId)
}

/**
 * One line of the bot's latest text for the row's second line. Collapsed to a
 * single line here as well as in the index, since a preview can still carry
 * newlines from a session indexed before this view existed.
 */
export function previewOf(session: SessionSummary | undefined): string | null {
  const preview = session?.lastMessagePreview?.replace(/\s+/g, ' ').trim()
  return preview !== undefined && preview.length > 0 ? preview : null
}

/**
 * Second line of a bot row: what the bot last said, else why there is nothing
 * to show — a bot with no session yet reads differently from one that has not
 * spoken, and neither should look broken.
 */
export function botSubtitle(bot: Bot, session: SessionSummary | undefined): string {
  return (
    previewOf(session) ?? (bot.mainSessionId === undefined ? 'No session yet' : 'No messages yet')
  )
}
