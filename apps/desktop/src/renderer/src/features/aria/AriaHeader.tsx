import { useState } from 'react'
import { AriaMark } from '@ari/ui/aria-mark'
import type { SessionSummary } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { ContextMenu, anchorBelow, type MenuAnchor } from '../../shell/ContextMenu'

export function AriaHeader({
  state,
  onNewTopic,
  onOpenSession,
}: {
  state: 'idle' | 'thinking' | 'working' | 'attention'
  onNewTopic: () => void
  onOpenSession: (id: string) => void
}) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const [topics, setTopics] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <span className="flex min-w-0 items-center gap-2 pl-3 text-sm font-medium text-fg">
        <AriaMark size={28} state={state} className="shrink-0 text-accent" />
        Aria
      </span>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onNewTopic}
          className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-1 hover:text-fg"
        >
          New topic
        </button>
        <button
          type="button"
          aria-expanded={anchor !== null}
          className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-1 hover:text-fg"
          onClick={(event) => {
            const anchor = anchorBelow(event.currentTarget)
            setError(null)
            void rpc
              .invoke('aria.topics')
              .then((list) => {
                setTopics(list)
                setAnchor(anchor)
              })
              .catch(() => setError('Could not load past topics.'))
          }}
        >
          Past topics
        </button>
      </div>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
      {anchor ? (
        <ContextMenu
          anchor={anchor}
          label="Past topics"
          onClose={() => setAnchor(null)}
          items={
            topics.length > 0
              ? topics.map((topic) => ({
                  id: topic.id,
                  label: topic.title,
                  onSelect: () => onOpenSession(topic.id),
                }))
              : [{ id: 'empty', label: 'No past topics', disabled: true, onSelect: () => {} }]
          }
        />
      ) : null}
    </>
  )
}
