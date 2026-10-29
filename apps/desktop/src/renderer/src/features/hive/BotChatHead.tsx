import type { Bot } from '@ari/contracts/bot'
import { BotAvatar } from '@ari/ui/bot-avatar'
import { characterOf } from '@ari/ui/bot-character'
import type { SessionActivity } from '../session/session-activity'
import { botMoodOf, botStatusOf } from './bot-mood'

/**
 * A bot session's head: the bot's face and identity above its chat, with a
 * status line that reads off the session's live turn phase ("Forge is
 * working…") and falls back to the bot's tagline when nothing is running.
 * Renders nothing while the bot is unresolved — a session whose bot is gone
 * from disk has no head, and guessing a face would draw a stranger.
 */
export function BotChatHead({
  bot,
  activity,
}: {
  bot: Bot | undefined
  activity?: SessionActivity
}) {
  if (bot === undefined) return null
  const title = bot.title?.trim() ?? ''
  const status = botStatusOf(activity)
  const subtitle = status ?? bot.tagline?.trim() ?? ''
  return (
    <header
      aria-label={title.length > 0 ? `${bot.name}, ${title}` : bot.name}
      className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4"
    >
      <BotAvatar
        character={characterOf(bot)}
        mood={botMoodOf(activity, undefined, 0)}
        size={36}
        className="shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-medium text-fg">{bot.name}</span>
          {title.length > 0 ? (
            <span className="truncate text-2xs text-fg-subtle">{title}</span>
          ) : null}
        </div>
        {subtitle.length > 0 ? (
          <p
            className={`truncate text-2xs ${status !== null ? 'text-fg-muted' : 'text-fg-subtle'}`}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
    </header>
  )
}
