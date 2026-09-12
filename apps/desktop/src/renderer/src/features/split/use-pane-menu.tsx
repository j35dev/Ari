import type { MouseEvent, ReactNode } from 'react'
import { Maximize2, Minimize2, PanelBottom, PanelRight, X } from 'lucide-react'
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../../shell/ContextMenu'
import { ownsContextMenu } from '../../shell/editable-target'
import { MAX_PANES, type PaneEdge } from './split-layout'

export interface PaneMenuOptions {
  paneId: string
  /** The pane's on-screen name; the menu is labelled with it. */
  label: string
  /** False at the pane ceiling, where a split would be refused anyway. */
  canSplit: boolean
  onSplit: (paneId: string, edge: PaneEdge) => void
  /** True while some pane fills the area, which is what the zoom entry undoes. */
  zoomed?: boolean
  /** Omitted on the only pane, which has no neighbour to close it beside. */
  onClose?: (paneId: string) => void
  /** Omitted on the only pane, which already fills the area. */
  onToggleZoom?: (paneId: string) => void
}

export interface PaneMenu {
  /** Goes on the pane's container, beside its drop handlers. */
  menuProps: { onContextMenu: (event: MouseEvent<HTMLElement>) => void }
  /** The menu itself once this pane's is the open one, otherwise null. */
  element: ReactNode
}

/**
 * The herdr pane menu, minus its terminal-specific entries. It never opens over
 * something that owns its own menu — a composer, a transcript's code block —
 * because those right-clicks belong to the text.
 *
 * Only the splits can be unavailable (at the ceiling). Closing and zooming are
 * offered exactly where they have something to do, which is beside another
 * pane: on the only pane, splitting is the whole menu.
 */
export function usePaneMenu({
  paneId,
  label,
  canSplit,
  onSplit,
  zoomed = false,
  onClose,
  onToggleZoom,
}: PaneMenuOptions): PaneMenu {
  const menu = useContextMenu()
  const splitLimit = `A layout holds at most ${String(MAX_PANES)} panes`
  const items: ContextMenuItem[] = [
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
  ]
  if (onToggleZoom !== undefined) {
    items.push({
      id: 'zoom',
      label: zoomed ? 'Unzoom pane' : 'Zoom pane',
      icon: zoomed ? Minimize2 : Maximize2,
      onSelect: () => onToggleZoom(paneId),
    })
  }
  if (onClose !== undefined) {
    items.push({
      id: 'close',
      label: 'Close pane',
      icon: X,
      danger: true,
      onSelect: () => onClose(paneId),
    })
  }
  return {
    menuProps: {
      onContextMenu: (event) => {
        if (ownsContextMenu(event.target)) return
        menu.open(paneId, event)
      },
    },
    element:
      menu.openFor === paneId ? (
        <ContextMenu
          anchor={menu.anchor}
          label={`${label} pane`}
          onClose={menu.close}
          items={items}
        />
      ) : null,
  }
}
