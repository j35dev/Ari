import { useState } from 'react'
import { History, MoreHorizontal, Plus } from 'lucide-react'
import { AriaMark } from '@ari/ui/aria-mark'
import type { SessionSummary } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { ContextMenu, type MenuAnchor } from '../../shell/ContextMenu'
import type { ariaActivity } from './aria-activity'

type RowMenu =
  | { kind: 'actions'; anchor: MenuAnchor }
  | { kind: 'topics'; anchor: MenuAnchor; topics: SessionSummary[] | null; error?: boolean }

export function AriaRow({
  selected,
  activity,
  onOpen,
  onNewTopic,
  onOpenSession,
}: {
  selected: boolean
  activity: ReturnType<typeof ariaActivity>
  onOpen: () => void
  onNewTopic: () => void
  onOpenSession: (id: string) => void
}) {
  const [menu, setMenu] = useState<RowMenu | null>(null)
  const count = activity.attention || activity.working
  const openMenu = (event: { clientX: number; clientY: number; preventDefault: () => void }) => {
    event.preventDefault()
    setMenu({ kind: 'actions', anchor: { x: event.clientX, y: event.clientY } })
  }
  const openTopics = (anchor: MenuAnchor) => {
    const pending: RowMenu = { kind: 'topics', anchor, topics: null }
    setMenu(pending)
    void rpc
      .invoke('aria.topics')
      .then((topics) =>
        setMenu((current) => (current === pending ? { ...pending, topics } : current)),
      )
      .catch(() =>
        setMenu((current) => (current === pending ? { ...pending, error: true } : current)),
      )
  }
  return (
    <div className="group/aria relative shrink-0 px-2 pb-1">
      <button
        type="button"
        aria-label="Open Aria"
        aria-current={selected ? 'page' : undefined}
        onClick={onOpen}
        onContextMenu={openMenu}
        title="Open Aria (Mod+0)"
        className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-md pl-2 pr-1 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${selected ? 'bg-accent/15 font-medium text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'}`}
      >
        <AriaMark size={16} state={activity.state} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">Aria</span>
        {count > 0 ? (
          <span
            className="pr-1 text-2xs tabular-nums text-accent transition-opacity group-hover/aria:opacity-0"
            title={activity.attention > 0 ? `${count} items need you` : `${count} sessions working`}
          >
            {count}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label="Aria actions"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={openMenu}
        className="absolute right-3.5 top-1 flex size-5 items-center justify-center rounded-sm text-fg-subtle opacity-0 hover:bg-surface-2 hover:text-fg group-hover/aria:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <MoreHorizontal size={13} aria-hidden />
      </button>
      {menu ? (
        <ContextMenu
          key={
            menu.kind === 'topics' && menu.topics === null && !menu.error ? 'loading' : menu.kind
          }
          anchor={menu.anchor}
          label={menu.kind === 'actions' ? 'Aria actions' : 'Past topics'}
          onClose={() => setMenu(null)}
          items={
            menu.kind === 'actions'
              ? [
                  { id: 'new', label: 'New topic', icon: Plus, onSelect: onNewTopic },
                  {
                    id: 'past',
                    label: 'Past topics',
                    icon: History,
                    onSelect: () => openTopics(menu.anchor),
                  },
                ]
              : menu.topics && menu.topics.length > 0
                ? menu.topics.map((topic) => ({
                    id: topic.id,
                    label: topic.title,
                    onSelect: () => onOpenSession(topic.id),
                  }))
                : [
                    {
                      id: 'empty',
                      label: menu.error
                        ? 'Could not load past topics.'
                        : menu.topics === null
                          ? 'Loading past topics…'
                          : 'No past topics',
                      disabled: true,
                      onSelect: () => {},
                    },
                  ]
          }
        />
      ) : null}
    </div>
  )
}
