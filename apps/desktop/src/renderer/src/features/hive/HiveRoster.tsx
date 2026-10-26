import { useState } from 'react'
import type { Bot } from '@ari/contracts/bot'
import type { DriverKind } from '@ari/contracts/common'
import type { SessionSummary } from '@ari/contracts/rpc'
import { Copy, Eye, EyeOff, Plus } from 'lucide-react'
import { Button } from '@ari/ui/button'
import { SessionActivityMark } from '../moment'
import type { SessionActivity } from '../session/session-activity'
import { botSubtitle, mainSessionOf, rosterOf } from './bot-roster'
import { NewBotDialog } from './NewBotDialog'
import { useBots } from './use-bots'

export interface HiveRosterProps {
  /** Every session the shell knows about; a bot's row reads its main one. */
  sessions: readonly SessionSummary[]
  /** Registered projects; a new bot needs one to work in. */
  projects: readonly { id: string; name: string }[]
  /** Live turn state, keyed by session — the bot's row shows its main session's. */
  activityOf?: (sessionId: string) => SessionActivity | undefined
  /** Provider and model a new bot starts on, from the user's last pick. */
  defaults: { driverKind: DriverKind; modelId: string | null }
  onOpenSession: (sessionId: string) => void
  /** A bot was created: its session is new, so the shell's list is stale. */
  onSessionsChanged?: () => void
}

const ICON_ACTION =
  'flex size-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/** One bot: its face, what it last said, and what it is doing right now. */
function BotRow({
  bot,
  session,
  activity,
  dimmed,
  onOpen,
  onDuplicate,
  onToggleHidden,
}: {
  bot: Bot
  session: SessionSummary | undefined
  activity: SessionActivity | undefined
  dimmed: boolean
  onOpen: () => void
  onDuplicate: (() => void) | null
  onToggleHidden: () => void
}) {
  return (
    <div
      className={`group flex items-center gap-1 rounded-lg px-1.5 py-1 transition-colors hover:bg-surface-2 ${
        dimmed ? 'opacity-55' : ''
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-base leading-none"
        >
          {bot.emoji}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg">{bot.name}</span>
          <span className="block truncate text-2xs text-fg-subtle">
            {botSubtitle(bot, session)}
          </span>
        </span>
      </button>

      {activity === undefined ? null : <SessionActivityMark activity={activity} />}

      {/* Always mounted so the actions stay reachable by keyboard; they only
          paint once the row is hovered or focused. */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {onDuplicate !== null ? (
          <button
            type="button"
            aria-label={`Duplicate ${bot.name}`}
            title="Duplicate"
            className={ICON_ACTION}
            onClick={onDuplicate}
          >
            <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={bot.hidden === true ? `Show ${bot.name}` : `Hide ${bot.name}`}
          title={bot.hidden === true ? 'Show in roster' : 'Hide from roster'}
          className={ICON_ACTION}
          onClick={onToggleHidden}
        >
          {bot.hidden === true ? (
            <Eye size={13} strokeWidth={1.8} aria-hidden="true" />
          ) : (
            <EyeOff size={13} strokeWidth={1.8} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  )
}

/**
 * The Hive: the bots on this machine as a team, not a list of threads. Hiding
 * a bot only takes it out of the roster — its sessions and persona stay.
 */
export function HiveRoster({
  sessions,
  projects,
  activityOf,
  defaults,
  onOpenSession,
  onSessionsChanged,
}: HiveRosterProps) {
  const { bots, loading, error, create, duplicate, setHidden } = useBots()
  const [showHidden, setShowHidden] = useState(false)
  const [creating, setCreating] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const visible = rosterOf(bots)
  const hiddenCount = bots.length - visible.length
  const listed = showHidden ? bots : visible
  const fallbackProjectId = projects[0]?.id ?? null

  const run = (work: () => Promise<unknown>): void => {
    setActionError(null)
    void work().catch((cause: unknown) => {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  return (
    <section aria-label="Hive roster" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 px-3 pt-1 pb-1">
        <h2 className="min-w-0 flex-1 truncate text-2xs font-medium tracking-wide text-fg-subtle uppercase">
          Bots
        </h2>
        <Button size="sm" variant="ghost" onClick={() => setCreating(true)}>
          <Plus size={13} strokeWidth={2} aria-hidden="true" />
          New bot
        </Button>
      </header>

      {error !== null ? (
        <p className="px-3 py-2 text-xs text-danger">{error}</p>
      ) : listed.length === 0 ? (
        // An empty roster is only an answer once the list has been read; saying
        // "no bots" before the first reply would flash that over a real team.
        loading ? (
          <div className="min-h-0 flex-1" />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-sm text-fg-muted">No bots yet</p>
            <p className="text-xs text-fg-subtle">Your bot team will appear here.</p>
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" role="list">
          {listed.map((bot) => {
            const session = mainSessionOf(bot, sessions)
            return (
              <div key={bot.id} role="listitem">
                <BotRow
                  bot={bot}
                  session={session}
                  activity={session === undefined ? undefined : activityOf?.(session.id)}
                  dimmed={bot.hidden === true}
                  onOpen={() => {
                    if (session !== undefined) onOpenSession(session.id)
                  }}
                  onDuplicate={
                    fallbackProjectId === null || bot.hidden === true
                      ? null
                      : () =>
                          run(async () => {
                            const copy = await duplicate(bot, fallbackProjectId)
                            onSessionsChanged?.()
                            if (copy.mainSessionId !== undefined) onOpenSession(copy.mainSessionId)
                          })
                  }
                  onToggleHidden={() => run(() => setHidden(bot.id, bot.hidden !== true))}
                />
              </div>
            )
          })}
        </div>
      )}

      {actionError !== null ? (
        <p role="alert" className="px-3 pb-1 text-xs text-danger">
          {actionError}
        </p>
      ) : null}

      {hiddenCount > 0 ? (
        <button
          type="button"
          aria-pressed={showHidden}
          onClick={() => setShowHidden((prev) => !prev)}
          className="mx-2 mb-2 rounded-md px-2 py-1 text-left text-2xs text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          {showHidden ? 'Hide them again' : `${hiddenCount} hidden`}
        </button>
      ) : null}

      <NewBotDialog
        open={creating}
        onOpenChange={setCreating}
        projects={projects}
        driverKind={defaults.driverKind}
        modelId={defaults.modelId}
        onCreate={create}
        onCreated={(bot) => {
          onSessionsChanged?.()
          if (bot.mainSessionId !== undefined) onOpenSession(bot.mainSessionId)
        }}
      />
    </section>
  )
}
