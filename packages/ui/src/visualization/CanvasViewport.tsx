import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'

const PADDING = 24,
  MIN_ZOOM = 0.01,
  MAX_ZOOM = 3
export const clampZoom = (value: number): number => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value))

/** A bounded, native two-axis scroller keeps diagrams out of the transcript's layout. */
export function CanvasViewport({
  width,
  height,
  label,
  children,
  controls,
}: {
  width: number
  height: number
  label: string
  children: ReactNode
  controls?: ReactNode
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)
  const anchor = useRef<{ x: number; y: number; localX: number; localY: number } | null>(null)
  const drag = useRef<{
    pointerId: number
    x: number
    y: number
    left: number
    top: number
  } | null>(null)
  const space = useRef(false)
  const [dragging, setDragging] = useState(false)
  const changeZoom = useCallback(
    (value: number, position?: { x: number; y: number }): void => {
      const el = viewport.current
      const next = clampZoom(value)
      if (!el || next === zoomRef.current) return
      const rect = el.getBoundingClientRect()
      const localX = position ? position.x - rect.left : el.clientWidth / 2
      const localY = position ? position.y - rect.top : el.clientHeight / 2
      anchor.current = {
        x:
          (el.scrollLeft +
            localX -
            Math.max(PADDING, (el.clientWidth - width * zoomRef.current) / 2)) /
          zoomRef.current,
        y:
          (el.scrollTop +
            localY -
            Math.max(PADDING, (el.clientHeight - height * zoomRef.current) / 2)) /
          zoomRef.current,
        localX,
        localY,
      }
      zoomRef.current = next
      setZoom(next)
    },
    [width, height],
  )
  useLayoutEffect(() => {
    const el = viewport.current,
      point = anchor.current
    if (el && point) {
      el.scrollLeft = Math.max(
        0,
        point.x * zoom + Math.max(PADDING, (el.clientWidth - width * zoom) / 2) - point.localX,
      )
      el.scrollTop = Math.max(
        0,
        point.y * zoom + Math.max(PADDING, (el.clientHeight - height * zoom) / 2) - point.localY,
      )
      anchor.current = null
    }
  }, [zoom, width, height])
  useLayoutEffect(() => {
    if (viewport.current) {
      viewport.current.scrollLeft = 0
      viewport.current.scrollTop = 0
    }
  }, [width, height])
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      changeZoom(zoomRef.current * Math.exp(-event.deltaY * 0.002), {
        x: event.clientX,
        y: event.clientY,
      })
    }
    const keyUp = (event: globalThis.KeyboardEvent): void => {
      if (event.code === 'Space') space.current = false
    }
    const blur = (): void => {
      space.current = false
      drag.current = null
      setDragging(false)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('keyup', keyUp)
    window.addEventListener('blur', blur)
    return () => {
      el.removeEventListener('wheel', wheel)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', blur)
    }
  }, [changeZoom])
  const fit = (): void => {
    const el = viewport.current
    if (!el) return
    const value = clampZoom(
      Math.min((el.clientWidth - PADDING * 2) / width, (el.clientHeight - PADDING * 2) / height, 1),
    )
    zoomRef.current = value
    anchor.current = null
    setZoom(value)
    el.scrollLeft = 0
    el.scrollTop = 0
  }
  const start = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'touch' || (event.button !== 0 && event.button !== 1)) return
    if (
      event.target instanceof Element &&
      event.target.closest('[data-viz-detail]') &&
      !space.current &&
      event.button !== 1
    )
      return
    const el = event.currentTarget
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
    }
    if (typeof el.setPointerCapture === 'function') el.setPointerCapture(event.pointerId)
    setDragging(true)
    event.preventDefault()
  }
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    event.currentTarget.scrollLeft = Math.max(0, current.left - (event.clientX - current.x))
    event.currentTarget.scrollTop = Math.max(0, current.top - (event.clientY - current.y))
  }
  const end = (): void => {
    drag.current = null
    setDragging(false)
  }
  const keyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest('button,input,select')) return
    if (event.key === ' ') {
      if (event.target instanceof Element && event.target.closest('[data-viz-detail]')) return
      space.current = true
      event.preventDefault()
      return
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      changeZoom(zoomRef.current * 1.25)
    } else if (event.key === '-') {
      event.preventDefault()
      changeZoom(zoomRef.current / 1.25)
    } else if (event.key === '0') {
      event.preventDefault()
      changeZoom(1)
    } else if (event.key.toLowerCase() === 'f') {
      event.preventDefault()
      fit()
    } else if (event.target === event.currentTarget && event.key.startsWith('Arrow')) {
      event.preventDefault()
      const amount = event.shiftKey ? 160 : 56
      if (event.key === 'ArrowRight') event.currentTarget.scrollLeft += amount
      if (event.key === 'ArrowLeft')
        event.currentTarget.scrollLeft = Math.max(0, event.currentTarget.scrollLeft - amount)
      if (event.key === 'ArrowDown') event.currentTarget.scrollTop += amount
      if (event.key === 'ArrowUp')
        event.currentTarget.scrollTop = Math.max(0, event.currentTarget.scrollTop - amount)
    }
  }
  return (
    <div className="ari-viz-canvas">
      <div className="ari-viz-canvas-toolbar">
        <div className="ari-viz-canvas-options">{controls}</div>
        <div className="ari-viz-zoom-controls" role="group" aria-label="Diagram zoom">
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out (−)"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => changeZoom(zoom / 1.25)}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Reset diagram zoom"
            title="Actual size (0)"
            onClick={() => changeZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in (+)"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => changeZoom(zoom * 1.25)}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Fit diagram to view"
            title="Fit the whole diagram (F)"
            onClick={fit}
          >
            Fit
          </button>
        </div>
      </div>
      <div
        ref={viewport}
        className="ari-viz-viewport"
        role="region"
        aria-label={`${label} canvas`}
        tabIndex={0}
        data-dragging={dragging ? '' : undefined}
        data-zoom={zoom}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyDown={keyboard}
      >
        <div
          className="ari-viz-artboard"
          style={{ width: width * zoom + PADDING * 2, height: height * zoom + PADDING * 2 }}
        >
          <div
            className="ari-viz-canvas-content"
            style={{
              width,
              height,
              transform: `scale(${zoom})`,
              left: `max(24px, calc((100% - ${width * zoom}px) / 2))`,
              top: `max(24px, calc((100% - ${height * zoom}px) / 2))`,
            }}
          >
            {children}
          </div>
        </div>
      </div>
      <div className="ari-viz-canvas-hint">
        Drag to pan · Scroll in either direction · Ctrl/⌘ + wheel to zoom
      </div>
    </div>
  )
}
