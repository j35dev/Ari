import type { ReactNode } from 'react'
import { GripVertical, TerminalSquare, X } from 'lucide-react'
import { Button } from '@ari/ui/button'
import { setDragPane } from './drag-split'
import { PaneDropOverlay } from './PaneDropOverlay'
import { usePaneDrop } from './use-pane-drop'
import { usePaneMenu } from './use-pane-menu'
import type { PaneEdge } from './split-layout'

export interface PaneFrameProps {
  paneId: string
  /** The session's name, or null while it is still loading or the pane is blank. */
  title: string | null
  focused: boolean
  /** A pane with no session: it has nothing to split, so a drop fills it whole. */
  blank: boolean
  /** True while some pane fills the area, which is what the zoom entry undoes. */
  zoomed: boolean
  /** False at the pane ceiling, where a split would be refused anyway. */
  canSplit: boolean
  onFocus: (paneId: string) => void
  onClose: (paneId: string) => void
  onSplit: (paneId: string, edge: PaneEdge) => void
  onToggleZoom: (paneId: string) => void
  onDropSession: (paneId: string, sessionId: string, edge: PaneEdge) => void
  onDropPane: (paneId: string, draggedPaneId: string) => void
  onOpenTerminal?: (paneId: string) => void
  canOpenTerminal?: boolean
  children: ReactNode
}

/**
 * One pane's chrome: the header from the reference layout, with the focused
 * pane taking the accent treatment the active sidebar row already uses. The
 * shell renders this only when the layout holds more than one pane, so a lone
 * pane keeps the chrome-free view it has always had.
 */
export function PaneFrame({
  paneId,
  title,
  focused,
  blank,
  zoomed,
  canSplit,
  onFocus,
  onClose,
  onSplit,
  onToggleZoom,
  onDropSession,
  onDropPane,
  onOpenTerminal,
  canOpenTerminal,
  children,
}: PaneFrameProps) {
  const label = title ?? 'Empty pane'
  const menu = usePaneMenu({
    paneId,
    label,
    canSplit,
    zoomed,
    onSplit,
    onClose,
    onToggleZoom,
    onOpenTerminal,
    canOpenTerminal,
  })
  const drop = usePaneDrop({ paneId, blank, canSplit, onDropSession, onDropPane })
  return (
    <section
      aria-label={label}
      // Focus follows the pointer and the keyboard, so a pane is the active one
      // before anything inside it reacts — clicking a composer focuses the pane.
      onPointerDownCapture={() => onFocus(paneId)}
      onFocusCapture={() => onFocus(paneId)}
      {...menu.menuProps}
      {...drop.dropProps}
      data-focused={focused}
      className="group/pane flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
    >
      <header
        // The header is the pane's grip: dragging it onto another pane trades
        // the two. Only the header, so the pane's own content keeps its drags.
        draggable
        onDragStart={(event) => setDragPane(event, paneId, label)}
        className={`flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b border-border px-2.5 active:cursor-grabbing ${
          focused ? 'bg-fg/4' : ''
        }`}
      >
        <GripVertical
          size={12}
          aria-hidden
          className="-ml-1 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover/pane:opacity-60"
        />
        <span
          title={label}
          className={`min-w-0 flex-1 truncate text-[12.5px] ${
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
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-subtle opacity-0 transition-[opacity,color,background-color] hover:bg-fg/9 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring group-hover/pane:opacity-100"
        >
          <X size={12} aria-hidden />
        </button>
      </header>
      {/* Deliberately not `overflow-hidden`: the composer's model picker, file
          suggestions and agent menu are plain absolutely-positioned children
          (not portals) anchored `bottom-full`, so clipping here would cut them
          off inside a narrow pane. Terminals clip themselves instead. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
        <PaneDropOverlay target={drop.target} />
      </div>
      {menu.element}
    </section>
  )
}

/**
 * A pane with no session in it. Splitting creates one, and so does moving the
 * session it held into another pane — either way the user fills it by dragging
 * a session in, so the placeholder says so.
 */
export function BlankPane({
  onOpenTerminal,
  canOpenTerminal = true,
}: {
  onOpenTerminal?: () => void
  canOpenTerminal?: boolean
} = {}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-4 text-center">
      <p className="text-sm font-medium text-fg">Empty pane</p>
      <p className="max-w-60 text-[13px] text-fg-subtle">
        Drag a session in from the sidebar, or open a terminal here.
      </p>
      {onOpenTerminal !== undefined ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={!canOpenTerminal}
          title={
            canOpenTerminal ? 'Open a terminal in this pane' : 'Add a project to open a terminal'
          }
          onClick={onOpenTerminal}
        >
          <TerminalSquare size={13} aria-hidden />
          Open terminal
        </Button>
      ) : null}
    </div>
  )
}
