import type { ReactNode } from 'react'
import { Maximize2, Minimize2, PanelBottom, PanelRight, X } from 'lucide-react'
import { ContextMenu, useContextMenu } from '../../shell/ContextMenu'
import { ownsContextMenu } from '../../shell/editable-target'
import { MAX_PANES, type PaneEdge } from './split-layout'

export interface PaneFrameProps {
  paneId: string
  /** The session's name, or null while it is still loading or the pane is blank. */
  title: string | null
  focused: boolean
  /** True while some pane fills the area, which is what the zoom entry undoes. */
  zoomed: boolean
  /** False at the pane ceiling, where a split would be refused anyway. */
  canSplit: boolean
  onFocus: (paneId: string) => void
  onClose: (paneId: string) => void
  onSplit: (paneId: string, edge: PaneEdge) => void
  onToggleZoom: (paneId: string) => void
  children: ReactNode
}

/**
 * One pane's chrome: the header from the reference layout, with the focused
 * pane taking the accent treatment the active sidebar row already uses. The
 * shell renders this only when the layout holds more than one pane, so a lone
 * pane keeps the chrome-free view it has always had.
 *
 * The right-click menu is the herdr one, minus its terminal-specific entries.
 * It never opens over something that owns its own menu — a composer, a
 * transcript's code block — because those right-clicks belong to the text.
 * Only the splits can be unavailable (at the ceiling): a frame is drawn only
 * beside another pane, so closing and zooming always have something to do.
 */
export function PaneFrame({
  paneId,
  title,
  focused,
  zoomed,
  canSplit,
  onFocus,
  onClose,
  onSplit,
  onToggleZoom,
  children,
}: PaneFrameProps) {
  const menu = useContextMenu()
  const label = title ?? 'Empty pane'
  const splitLimit = `A layout holds at most ${String(MAX_PANES)} panes`
  return (
    <section
      aria-label={label}
      // Focus follows the pointer and the keyboard, so a pane is the active one
      // before anything inside it reacts — clicking a composer focuses the pane.
      onPointerDownCapture={() => onFocus(paneId)}
      onFocusCapture={() => onFocus(paneId)}
      onContextMenu={(event) => {
        if (ownsContextMenu(event.target)) return
        menu.open(paneId, event)
      }}
      className={`flex h-full min-h-0 w-full min-w-0 flex-1 flex-col border ${
        focused ? 'border-accent/40' : 'border-border/60'
      }`}
    >
      <header
        className={`flex h-7 shrink-0 items-center gap-1.5 border-b px-2 ${
          focused ? 'border-accent/25 bg-accent/10' : 'border-border/60'
        }`}
      >
        <span
          className={`min-w-0 flex-1 truncate text-2xs ${
            focused ? 'font-medium text-fg' : 'text-fg-subtle'
          }`}
        >
          {label}
        </span>
        <button
          type="button"
          aria-label={`Close ${label}`}
          title="Close pane"
          onClick={() => onClose(paneId)}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <X size={10} aria-hidden />
        </button>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      {menu.openFor === paneId ? (
        <ContextMenu
          anchor={menu.anchor}
          label={`${label} pane`}
          onClose={menu.close}
          items={[
            {
              id: 'split-right',
              label: 'Split right',
              icon: PanelRight,
              disabled: !canSplit,
              disabledReason: splitLimit,
              onSelect: () => onSplit(paneId, 'right'),
            },
            {
              id: 'split-down',
              label: 'Split down',
              icon: PanelBottom,
              disabled: !canSplit,
              disabledReason: splitLimit,
              onSelect: () => onSplit(paneId, 'below'),
            },
            {
              id: 'zoom',
              label: zoomed ? 'Unzoom pane' : 'Zoom pane',
              icon: zoomed ? Minimize2 : Maximize2,
              onSelect: () => onToggleZoom(paneId),
            },
            {
              id: 'close',
              label: 'Close pane',
              icon: X,
              danger: true,
              onSelect: () => onClose(paneId),
            },
          ]}
        />
      ) : null}
    </section>
  )
}

/**
 * A pane with no session in it. Splitting creates one, and so does moving the
 * session it held into another pane — either way the user fills it by dragging
 * a session in, so the placeholder says so.
 */
export function BlankPane() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1.5 p-4 text-center">
      <p className="text-xs text-fg-subtle">No session in this pane</p>
      <p className="max-w-56 text-2xs text-fg-subtle/70">
        Drag a session in from the sidebar, or right-click the pane for Split right and Split down.
      </p>
    </div>
  )
}
