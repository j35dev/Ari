import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronUp, GitBranch } from 'lucide-react'
import { transitions } from '@ari/ui/motion'
import type { SessionSummary } from '@ari/contracts/rpc'
import { SessionActivityMark } from '../moment'
import type { SessionActivity } from './session-activity'

/**
 * Compact composer-top rail. Live children expand inside the same cap as
 * the rail so the list reads as part of the composer, not a floating menu.
 */
export function ChildSessionActivity({
  sessions,
  activityOf,
  onOpen,
  onStopAll,
}: {
  sessions: SessionSummary[]
  activityOf?: (id: string) => SessionActivity | undefined
  onOpen?: (id: string) => void
  /**
   * Stops everything running below this session. Passed only while there is
   * something to stop and this session has no turn of its own to stop instead.
   */
  onStopAll?: () => void
}) {
  const [open, setOpen] = useState(false)
  if (sessions.length === 0) return null
  const working = sessions.filter((session) => activityOf?.(session.id)?.phase === 'working').length
  // A child waiting on an approval or a question is stuck until someone
  // answers it in that child, and from here nothing else says so.
  const blocked = sessions.filter((session) => activityOf?.(session.id)?.phase === 'paused')
  const firstBlocked = blocked[0]
  return (
    <div>
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
            {sessions.map((session) => {
              const activity = activityOf?.(session.id)
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onOpen?.(session.id)
                      setOpen(false)
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                  >
                    <span className="flex size-2.5 shrink-0 items-center justify-center">
                      {activity ? (
                        <SessionActivityMark activity={activity} />
                      ) : (
                        <span aria-hidden className="size-1 rounded-[1px] bg-fg-subtle/50" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-fg">{session.title}</span>
                    <span
                      className={`shrink-0 font-mono text-2xs ${activity?.phase === 'paused' ? 'text-warning' : 'text-fg-subtle'}`}
                    >
                      {activity?.phase === 'working'
                        ? 'working'
                        : activity?.phase === 'paused'
                          ? 'needs you'
                          : session.status}
                    </span>
                  </button>
                </li>
              )
            })}
          </motion.ul>
        ) : null}
      </AnimatePresence>
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          aria-label="Child sessions"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-2xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <GitBranch size={11} aria-hidden className="shrink-0 text-accent" />
          <span className="shrink-0 font-medium text-fg">
            {sessions.length} child{sessions.length === 1 ? '' : 'ren'}
          </span>
          {blocked.length > 0 ? (
            <span className="truncate text-warning">
              {blocked.length === 1
                ? `${firstBlocked?.title ?? 'One'} needs you`
                : `${blocked.length} need you`}
            </span>
          ) : null}
          <span className="shrink-0">
            {working > 0 ? `${working} working` : blocked.length > 0 ? null : 'idle'}
          </span>
          <ChevronUp
            size={11}
            aria-hidden
            className={`ms-auto shrink-0 transition-transform duration-150 ${open ? '' : 'rotate-180'}`}
          />
        </button>
        {firstBlocked && onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(firstBlocked.id)}
            className="me-2 shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-2xs text-fg transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            Answer
          </button>
        ) : null}
        {onStopAll ? (
          <button
            type="button"
            onClick={onStopAll}
            title="Stop every session this one delegated to"
            className="me-2 shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-2xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            Stop all
          </button>
        ) : null}
      </div>
    </div>
  )
}
