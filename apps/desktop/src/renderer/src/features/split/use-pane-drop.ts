import { useCallback, useState } from 'react'
import type { DragEvent } from 'react'
import { hasDragType, readDragPane, readDragSession, PANE_MIME, SESSION_MIME } from './drag-split'
import { edgeForPoint } from './split-geometry'
import type { PaneEdge } from './split-layout'

/** Where a drop would land: a whole pane, or the half of one that would split. */
export type PaneDropTarget = 'fill' | PaneEdge

export interface PaneDrop {
  /** Null while no pane drag is over this pane. */
  target: PaneDropTarget | null
  dropProps: {
    onDragOver: (event: DragEvent<HTMLElement>) => void
    onDragLeave: (event: DragEvent<HTMLElement>) => void
    onDrop: (event: DragEvent<HTMLElement>) => void
  }
}

/**
 * The drop half of a pane: which part of it a drag is over, and what to do when
 * it is let go. A session lands on the edge nearest the pointer — the video's
 * rule, one gesture that both splits and fills. A blank pane takes it whole,
 * because there is nothing there to split, and so does a pane being swapped
 * with, because a swap has no side.
 */
export function usePaneDrop(options: {
  paneId: string
  /** Filled panes split on the drop edge; a blank one takes the session whole. */
  blank: boolean
  onDropSession: (paneId: string, sessionId: string, edge: PaneEdge) => void
  onDropPane: (paneId: string, draggedPaneId: string) => void
}): PaneDrop {
  const { paneId, blank, onDropSession, onDropPane } = options
  const [target, setTarget] = useState<PaneDropTarget | null>(null)

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      if (hasDragType(event, PANE_MIME)) {
        // A swap has no side, so the whole pane lights up.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setTarget('fill')
        return
      }
      if (!hasDragType(event, SESSION_MIME)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const box = event.currentTarget.getBoundingClientRect()
      setTarget(blank ? 'fill' : edgeForPoint({ x: event.clientX, y: event.clientY }, box))
    },
    [blank],
  )

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>): void => {
    // `dragleave` also fires moving between children, so only a departure from
    // the pane itself clears the overlay.
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setTarget(null)
  }, [])

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      setTarget(null)
      const draggedPane = readDragPane(event)
      if (draggedPane !== null) {
        event.preventDefault()
        onDropPane(paneId, draggedPane)
        return
      }
      const sessionId = readDragSession(event)
      if (sessionId === null) return
      event.preventDefault()
      const box = event.currentTarget.getBoundingClientRect()
      const edge = blank ? 'right' : edgeForPoint({ x: event.clientX, y: event.clientY }, box)
      onDropSession(paneId, sessionId, edge)
    },
    [blank, onDropPane, onDropSession, paneId],
  )

  return { target, dropProps: { onDragOver, onDragLeave, onDrop } }
}
