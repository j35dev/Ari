import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronUp, GitBranch } from 'lucide-react'
import { transitions } from '@ari/ui/motion'
import type { SessionSummary } from '@ari/contracts/rpc'
import { SessionActivityMark } from '../moment'
import type { SessionActivity } from './session-activity'

/** Compact composer-top rail; the drop-up lists live children, not journal history. */
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
    <div className="relative">
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
      <AnimatePresence>
        {open ? (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: 4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.97 }}
              transition={transitions.menuIn}
              role="menu"
              aria-label="Child sessions"
              className="ari-glass-overlay absolute bottom-full left-0 right-0 z-40 mb-1 max-h-64 overflow-y-auto rounded-lg border border-border p-1 shadow-2"
            >
              {sessions.map((session) => {
                const activity = activityOf?.(session.id)
                return (
                  <button
                    key={session.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onOpen?.(session.id)
                      setOpen(false)
                    }}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                  >
                    <span className="flex size-2.5 shrink-0 items-center justify-center">
                      {activity ? <SessionActivityMark activity={activity} /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-fg">{session.title}</span>
                    <span className="shrink-0 font-mono text-2xs text-fg-subtle">
                      {activity?.phase === 'working' ? 'working' : session.status}
                    </span>
                  </button>
                )
              })}
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
