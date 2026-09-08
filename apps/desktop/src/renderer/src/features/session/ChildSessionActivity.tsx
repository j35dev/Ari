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
}: {
  sessions: SessionSummary[]
  activityOf?: (id: string) => SessionActivity | undefined
  onOpen?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (sessions.length === 0) return null
  const working = sessions.filter((session) => activityOf?.(session.id)?.phase === 'working').length
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
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-glass-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                  >
                    <span className="flex size-2.5 shrink-0 items-center justify-center">
                      {activity ? (
                        <SessionActivityMark activity={activity} />
                      ) : (
                        <span aria-hidden className="size-1 rounded-[1px] bg-fg-subtle/50" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-fg">{session.title}</span>
                    <span className="shrink-0 font-mono text-2xs text-fg-subtle">
                      {activity?.phase === 'working' ? 'working' : session.status}
                    </span>
                  </button>
                </li>
              )
            })}
          </motion.ul>
        ) : null}
      </AnimatePresence>
      <button
        type="button"
        aria-expanded={open}
        aria-label="Child sessions"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-2xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <GitBranch size={11} aria-hidden className="text-accent" />
        <span className="font-medium text-fg">
          {sessions.length} child{sessions.length === 1 ? '' : 'ren'}
        </span>
        <span>{working > 0 ? `${working} working` : 'idle'}</span>
        <ChevronUp
          size={11}
          aria-hidden
          className={`ms-auto shrink-0 transition-transform duration-150 ${open ? '' : 'rotate-180'}`}
        />
      </button>
    </div>
  )
}
