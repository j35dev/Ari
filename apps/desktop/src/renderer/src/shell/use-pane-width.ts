import { useCallback, useEffect, useRef, useState } from 'react'

/** One resizable shell pane: where it sits, how wide it may get, where it persists. */
export interface PaneWidthConfig {
  storageKey: string
  min: number
  max: number
  default: number
  /**
   * Which window edge the pane is docked to. A right-docked pane grows when its
   * handle is dragged left, so the pointer delta is inverted.
   */
  edge: 'left' | 'right'
}

export interface PaneWidth {
  width: number
  dragging: boolean
  handleProps: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
    onDoubleClick: () => void
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
  }
}

const SIDEBAR: PaneWidthConfig = {
  storageKey: 'ari.sidebar.width',
  min: 200,
  max: 520,
  default: 280,
  edge: 'left',
}

/** The trailing rail: wide enough for ~80 columns of shell output by default. */
const DOCK: PaneWidthConfig = {
  storageKey: 'ari.dock.width',
  min: 320,
  max: 900,
  default: 520,
  edge: 'right',
}

/**
 * Drag-to-resize pane width, persisted in localStorage (ephemeral UI state,
 * like the sidebar collapse flag). Pointer capture keeps the drag alive over
 * the transcript; double-click on the handle restores the default.
 */
export function usePaneWidth(config: PaneWidthConfig): PaneWidth {
  const { storageKey, min, max, default: fallback, edge } = config
  const clamp = useCallback(
    (value: number): number => Math.min(max, Math.max(min, Math.round(value))),
    [max, min],
  )

  const [width, setWidth] = useState(() => {
    const raw = Number(localStorage.getItem(storageKey))
    return Number.isFinite(raw) && raw > 0
      ? Math.min(max, Math.max(min, Math.round(raw)))
      : fallback
  })
  const [dragging, setDragging] = useState(false)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    localStorage.setItem(storageKey, String(width))
  }, [storageKey, width])

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  const sign = edge === 'right' ? -1 : 1

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>): void => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      setDragging(true)
      const startX = e.clientX
      const startWidth = width

      const onMove = (move: PointerEvent): void => {
        // One update per frame: pointermove fires far faster than we can paint.
        if (frameRef.current !== null) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null
          setWidth(clamp(startWidth + sign * (move.clientX - startX)))
        })
      }
      const onUp = (): void => {
        setDragging(false)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [clamp, sign, width],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const delta = (e.key === 'ArrowRight' ? 16 : -16) * sign
      setWidth((w) => clamp(w + delta))
    },
    [clamp, sign],
  )

  return {
    width,
    dragging,
    handleProps: { onPointerDown, onDoubleClick: () => setWidth(fallback), onKeyDown },
  }
}

/** The session sidebar on the leading edge. */
export function useSidebarWidth(): PaneWidth {
  return usePaneWidth(SIDEBAR)
}

/** The inspector rail on the trailing edge: terminal, files, changes. */
export function useDockWidth(): PaneWidth {
  return usePaneWidth(DOCK)
}

export const SIDEBAR_WIDTH_BOUNDS = { min: SIDEBAR.min, max: SIDEBAR.max, default: SIDEBAR.default }
export const DOCK_WIDTH_BOUNDS = { min: DOCK.min, max: DOCK.max, default: DOCK.default }
