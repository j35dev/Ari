import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'ari.sidebar.width'
const MIN_WIDTH = 200
const MAX_WIDTH = 520
const DEFAULT_WIDTH = 280

function clamp(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)))
}

function readStored(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY))
  return Number.isFinite(raw) && raw > 0 ? clamp(raw) : DEFAULT_WIDTH
}

/**
 * Drag-to-resize sidebar width, persisted in localStorage (ephemeral UI state,
 * like the collapse flag). Pointer capture keeps the drag alive over the
 * transcript; double-click on the handle restores the default.
 */
export function useSidebarWidth(): {
  width: number
  dragging: boolean
  handleProps: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
    onDoubleClick: () => void
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
  }
} {
  const [width, setWidth] = useState(readStored)
  const [dragging, setDragging] = useState(false)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(width))
  }, [width])

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>): void => {
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
        setWidth(clamp(startWidth + (move.clientX - startX)))
      })
    }
    const onUp = (): void => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [width])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setWidth((w) => clamp(w - 16))
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      setWidth((w) => clamp(w + 16))
    }
  }, [])

  return {
    width,
    dragging,
    handleProps: { onPointerDown, onDoubleClick: () => setWidth(DEFAULT_WIDTH), onKeyDown },
  }
}

export const SIDEBAR_WIDTH_BOUNDS = { min: MIN_WIDTH, max: MAX_WIDTH, default: DEFAULT_WIDTH }
