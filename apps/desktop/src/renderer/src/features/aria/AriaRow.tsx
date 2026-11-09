import { useState } from 'react'
import { MoreHorizontal, Plus, X } from 'lucide-react'
import { AriaMark } from '@ari/ui/aria-mark'
import { ContextMenu, type MenuAnchor } from '../../shell/ContextMenu'
import type { ariaActivity } from './aria-activity'

export function AriaRow({
  selected,
  activity,
  onOpen,
  onNewChat,
}: {
  selected: boolean
  activity: ReturnType<typeof ariaActivity>
  onOpen: () => void
  onNewChat: () => void
}) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const [confirmNewChat, setConfirmNewChat] = useState(false)
  const count = activity.attention || activity.working
  const openMenu = (event: { clientX: number; clientY: number; preventDefault: () => void }) => {
    event.preventDefault()
    setAnchor({ x: event.clientX, y: event.clientY })
  }
  if (confirmNewChat) {
    return (
      <div className="shrink-0 px-2 pb-1">
        <div className="flex items-center gap-2 rounded-md bg-danger-subtle px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-2xs text-danger">Delete Aria chat?</span>
          <button
            type="button"
            aria-label="Confirm new Aria chat"
            onClick={() => {
              setConfirmNewChat(false)
              onNewChat()
            }}
            className="shrink-0 rounded-sm bg-danger px-1.5 py-0.5 text-2xs font-medium text-fg-on-accent"
          >
            New chat
          </button>
          <button
            type="button"
            aria-label="Cancel new Aria chat"
            onClick={() => setConfirmNewChat(false)}
            className="shrink-0 text-fg-subtle hover:text-fg"
          >
            <X size={13} />
          </button>
        </div>
      </div>
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
        aria-expanded={anchor !== null}
        onClick={openMenu}
        className="absolute right-3.5 top-1 flex size-5 items-center justify-center rounded-sm text-fg-subtle opacity-0 hover:bg-surface-2 hover:text-fg group-hover/aria:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <MoreHorizontal size={13} aria-hidden />
      </button>
      {anchor ? (
        <ContextMenu
          anchor={anchor}
          label="Aria actions"
          onClose={() => setAnchor(null)}
          items={[
            {
              id: 'new',
              label: 'New chat',
              icon: Plus,
              danger: true,
              onSelect: () => setConfirmNewChat(true),
            },
          ]}
        />
      ) : null}
    </div>
  )
}
