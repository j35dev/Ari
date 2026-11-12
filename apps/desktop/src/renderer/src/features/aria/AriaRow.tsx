import { useState } from 'react'
import { MoreHorizontal, Plus, X } from 'lucide-react'
import { AriaMark } from '@ari/ui/aria-mark'
import { ContextMenu, type MenuAnchor } from '../../shell/ContextMenu'
import { countBadge, cx, rowAction, rowSelected } from '../../lib/recipes'
import type { ariaActivity } from './aria-activity'

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/** The sidebar's 34px nav row, the same row as New session below it. */
const NAV_ROW = `flex h-[34px] w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors ${FOCUS_RING}`

/** {@link countBadge}'s shape in neutral ink: sessions running, nothing to answer. */
const WORKING_BADGE =
  'inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-fg/9 px-1 text-[11px] font-semibold leading-none text-fg-muted'

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
      <div className="shrink-0 px-2.5 pb-px">
        <div className="flex h-[34px] items-center gap-2 rounded-md bg-danger-subtle pl-2.5 pr-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-danger">Delete Aria chat?</span>
          <button
            type="button"
            aria-label="Confirm new Aria chat"
            onClick={() => {
              setConfirmNewChat(false)
              onNewChat()
            }}
            className={`inline-flex h-6 shrink-0 items-center rounded-sm bg-danger px-2 text-xs font-medium text-fg-on-accent transition-colors hover:bg-danger-hover ${FOCUS_RING}`}
          >
            New chat
          </button>
          <button
            type="button"
            aria-label="Cancel new Aria chat"
            onClick={() => setConfirmNewChat(false)}
            className={rowAction}
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="group/aria relative shrink-0 px-2.5 pb-px">
      <button
        type="button"
        aria-label="Open Aria"
        aria-current={selected ? 'page' : undefined}
        onClick={onOpen}
        onContextMenu={openMenu}
        title="Open Aria (Mod+0)"
        className={cx(
          NAV_ROW,
          selected
            ? rowSelected
            : 'text-fg-muted group-hover/aria:bg-fg/5 group-hover/aria:text-fg',
        )}
      >
        <AriaMark size={16} state={activity.state} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">Aria</span>
        {count > 0 ? (
          <span
            className={cx(
              activity.attention > 0 ? countBadge : WORKING_BADGE,
              'tabular-nums transition-opacity group-hover/aria:opacity-0',
            )}
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
        className={cx(
          rowAction,
          'absolute right-[19px] top-[7px] opacity-0 group-hover/aria:opacity-100 focus-visible:opacity-100',
        )}
      >
        <MoreHorizontal size={14} aria-hidden />
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
