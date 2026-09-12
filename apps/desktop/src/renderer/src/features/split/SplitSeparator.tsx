import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_RATIO, MIN_RATIO, type SplitDirection } from './split-layout'

/** Share of the split one arrow-key press gives the leading pane. */
const KEY_STEP = 0.02

/** What a double-click restores: the ratio a split is created with. */
const EVEN = 0.5

export interface SplitSeparatorProps {
  nodeId: string
  /** Which panes this divider sits between, for anyone listening rather than looking. */
  label: string
  direction: SplitDirection
  ratio: number
  onResize: (nodeId: string, ratio: number) => void
  /** Zoom hides the divider in place so the pane tree never remounts. */
  hidden?: boolean
}

/**
 * The divider between two panes. Dragging it turns the pointer's position
 * inside the split into a share for the leading pane, which is the same
 * gesture as the two shell separators — pointer capture so the drag survives
 * crossing the panes, one update per frame, arrows to nudge, double-click to
 * even the split back up.
 *
 * The ratio is measured against the separator's parent, because that element
 * is exactly the box the two panes divide.
 */
export function SplitSeparator({
  nodeId,
  label,
  direction,
  ratio,
  onResize,
  hidden = false,
}: SplitSeparatorProps) {
  const row = direction === 'row'
  const [dragging, setDragging] = useState(false)
  const frameRef = useRef<number | null>(null)
  const lastRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  const shareAt = useCallback(
    (box: DOMRect, x: number, y: number): number => {
      const span = row ? box.width : box.height
      if (span <= 0) return ratio
      return row ? (x - box.left) / span : (y - box.top) / span
    },
    [ratio, row],
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      e.preventDefault()
      const box = e.currentTarget.parentElement?.getBoundingClientRect()
      if (box === undefined) return
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(true)

      const onMove = (move: PointerEvent): void => {
        // One update per frame: pointermove fires far faster than we can paint.
        lastRef.current = { x: move.clientX, y: move.clientY }
        if (frameRef.current !== null) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          const at = lastRef.current
          if (at !== null) onResize(nodeId, shareAt(box, at.x, at.y))
        })
      }
      const onUp = (): void => {
        setDragging(false)
        lastRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [nodeId, onResize, shareAt],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const back = row ? 'ArrowLeft' : 'ArrowUp'
      const forward = row ? 'ArrowRight' : 'ArrowDown'
      if (e.key !== back && e.key !== forward) return
      e.preventDefault()
      onResize(nodeId, ratio + (e.key === forward ? KEY_STEP : -KEY_STEP))
    },
    [nodeId, onResize, ratio, row],
  )

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(MIN_RATIO * 100)}
      aria-valuemax={Math.round(MAX_RATIO * 100)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={() => onResize(nodeId, EVEN)}
      onKeyDown={onKeyDown}
      className={`shrink-0 transition-colors focus-visible:outline-none focus-visible:bg-accent ${
        hidden ? 'hidden' : row ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
      } ${dragging ? 'bg-accent' : 'bg-transparent hover:bg-accent-subtle'}`}
    />
  )
}
