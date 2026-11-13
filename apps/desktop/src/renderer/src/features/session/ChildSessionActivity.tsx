import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Bot, ChevronRight } from 'lucide-react'
import { driverLabel } from '../composer/agent-mark'
import { hasProviderLogo, ProviderLogo } from '../composer/provider-logo'
import { transitions } from '@ari/ui/motion'
import type { SessionSummary } from '@ari/contracts/rpc'
import { cx, primaryButton, quietButton } from '../../lib/recipes'
import { ElapsedSeconds } from '../moment'
import { ACTIVITY_LABEL, type SessionActivity, type SessionActivityPhase } from './session-activity'

/**
 * One section of the tab on the composer's top edge. The composer draws the
 * tab itself (its `above` slot: the edge, the shoulders, the stage fill), so a
 * section only keeps the tab's 14px inset.
 */
export const composerTabSection = 'px-3.5'

/** The 40px summary row of a {@link composerTabSection}. */
export const composerTabRail =
  'flex h-10 min-w-0 flex-1 items-center gap-3 rounded-md text-left text-[13px] text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/** One 32px row of an opened {@link composerTabSection}. */
export const composerTabRow = 'flex h-8 min-w-0 items-center gap-2.5 text-[13px]'

const STATUS_GLYPH: Record<SessionActivityPhase, string> = {
  queued: 'queued',
  working: 'working',
  paused: 'attention',
  done: 'done',
  error: 'error',
}

/** Tiles shown in the stack; the count beside them carries the rest. */
const MAX_TILES = 3

/**
 * Delegated sessions as one row on the composer: who is out there, the state
 * in words, and how long the oldest has been working. Opened, the children
 * list above the row inside the same tab, so it reads as part of the
 * composer, not a floating menu.
 */
export function ChildSessionActivity({
  sessions,
  activityOf,
  onOpen,
  onStopAll,
  stopping = false,
}: {
  sessions: SessionSummary[]
  activityOf?: (id: string) => SessionActivity | undefined
  onOpen?: (id: string) => void
  /**
   * Stops everything running below this session. Passed only while there is
   * something to stop and this session has no turn of its own to stop instead.
   */
  onStopAll?: () => void
  stopping?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (sessions.length === 0) return null
  const working = sessions.filter((session) => activityOf?.(session.id)?.phase === 'working')
  const queued = sessions.filter((session) => activityOf?.(session.id)?.phase === 'queued').length
  // A child waiting on an approval or a question is stuck until someone
  // answers it in that child, and from here nothing else says so.
  const blocked = sessions.filter((session) => activityOf?.(session.id)?.phase === 'paused')
  const firstBlocked = blocked[0]
  const oldest = working.reduce<number | null>((min, session) => {
    const startedAt = activityOf?.(session.id)?.startedAt ?? null
    return startedAt !== null && (min === null || startedAt < min) ? startedAt : min
  }, null)

  const quiet: string[] = []
  if (working.length > 0) quiet.push(`${working.length} working`)
  if (queued > 0) quiet.push(`${queued} queued`)
  if (quiet.length === 0 && blocked.length === 0) quiet.push('idle')

  return (
    <div className={composerTabSection}>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            key="children"
            role="list"
            aria-label="Child sessions"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={transitions.morph}
            className="overflow-hidden"
          >
            {sessions.map((session, index) => {
              const activity = activityOf?.(session.id)
              const needsUser = activity?.phase === 'paused'
              return (
                <li key={session.id} className={index === 0 ? 'pt-1.5' : undefined}>
                  <button
                    type="button"
                    onClick={() => {
                      onOpen?.(session.id)
                      setOpen(false)
                    }}
                    className={cx(
                      composerTabRow,
                      '-mx-2 group w-[calc(100%+1rem)] rounded-md px-2 text-left transition-colors hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
                    )}
                  >
                    {activity ? (
                      <span
                        role="status"
                        aria-label={ACTIVITY_LABEL[activity.phase]}
                        title={ACTIVITY_LABEL[activity.phase]}
                        className="ari-status"
                        data-status={STATUS_GLYPH[activity.phase]}
                      />
                    ) : (
                      <span aria-hidden className="ari-status" />
                    )}
                    <span className="min-w-0 shrink truncate text-fg">{session.title}</span>
                    <span
                      className={`min-w-0 flex-1 truncate ${needsUser ? 'text-accent' : 'text-fg-muted'}`}
                    >
                      {activity?.phase === 'working'
                        ? 'working'
                        : activity?.phase === 'queued'
                          ? 'queued'
                          : needsUser
                            ? 'needs you'
                            : session.status}
                    </span>
                    <span
                      className={`shrink-0 transition-colors group-hover:text-fg group-focus-visible:text-fg ${needsUser ? 'font-medium text-fg' : 'text-fg-subtle'}`}
                    >
                      {needsUser ? 'Answer' : 'Open'}
                    </span>
                  </button>
                </li>
              )
            })}
          </motion.ul>
        ) : null}
      </AnimatePresence>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label="Child sessions"
          onClick={() => setOpen((value) => !value)}
          className={composerTabRail}
        >
          {/* Side by side, not stacked: an overlap would clip each logo. */}
          <span aria-hidden className="flex shrink-0 gap-1">
            {sessions.slice(0, MAX_TILES).map((session) => (
              <span
                key={session.id}
                title={session.driverKind ? driverLabel(session.driverKind) : undefined}
                className="grid size-[22px] place-items-center rounded-full bg-surface-2 text-fg-muted"
              >
                <AgentGlyph kind={session.driverKind} />
              </span>
            ))}
          </span>
          <span className="shrink-0 font-medium text-fg">
            {sessions.length} agent{sessions.length === 1 ? '' : 's'}
          </span>
          <span className="min-w-0 truncate">
            {quiet.join(', ')}
            {blocked.length > 0 ? (
              <>
                {quiet.length > 0 ? ', ' : ''}
                <span className="text-accent">
                  {blocked.length === 1
                    ? `${firstBlocked?.title ?? 'One'} needs you`
                    : `${blocked.length} need you`}
                </span>
              </>
            ) : null}
          </span>
          <span className="ms-auto flex shrink-0 items-center gap-2 text-fg-subtle">
            {oldest !== null ? <ElapsedSeconds startedAt={oldest} /> : null}
            <ChevronRight
              size={14}
              aria-hidden
              className={`shrink-0 transition-transform duration-150 ${open ? '-rotate-90' : ''}`}
            />
          </span>
        </button>
        {firstBlocked && onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(firstBlocked.id)}
            className={cx(primaryButton, 'shrink-0')}
          >
            Answer
          </button>
        ) : null}
        {onStopAll ? (
          <button
            type="button"
            disabled={stopping}
            onClick={onStopAll}
            title="Stop every session this one delegated to"
            className={cx(quietButton, 'shrink-0')}
          >
            {stopping ? 'Stopping…' : 'Stop all'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** A child's tile: the logo of the agent it runs, or a plain bot glyph. */
function AgentGlyph({ kind }: { kind: string | undefined }) {
  return kind && hasProviderLogo(kind) ? (
    <ProviderLogo kind={kind} size={12} />
  ) : (
    <Bot size={13} strokeWidth={1.8} aria-hidden />
  )
}
