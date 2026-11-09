import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react-dom'
import { layerRoot } from '../layer-root'

export interface PointDetail {
  title: string
  description?: string
  rows?: { label: string; value: string | number; color?: string }[]
  note?: string
}

/** Values are authored by the renderers, then escaped by React as a data attribute. */
export const pointDetail = (detail: PointDetail): string => JSON.stringify(detail)
const pointOf = (target: EventTarget | null): Element | null =>
  target instanceof Element ? target.closest('[data-viz-detail]') : null

function detailOf(point: Element): PointDetail | null {
  try {
    return JSON.parse(point.getAttribute('data-viz-detail') ?? 'null') as PointDetail | null
  } catch {
    return null
  }
}

/** One portal per visual, rather than one tooltip instance per SVG mark. */
export function InteractiveSurface({
  children,
  resetKey = '',
}: {
  children: ReactNode
  resetKey?: string
}) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const active = useRef<{ point: Element; detail: PointDetail; pinned: boolean } | null>(null)
  const [shown, setShown] = useState<typeof active.current>(null)
  const { refs, floatingStyles, update, isPositioned } = useFloating({
    strategy: 'fixed',
    placement: 'top-start',
    transform: false,
    middleware: [offset(12), flip({ padding: 12 }), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  })
  const hide = useCallback((): void => {
    const previous = active.current?.point
    previous?.removeAttribute('data-viz-pinned')
    previous?.removeAttribute('aria-describedby')
    active.current = null
    setShown(null)
  }, [])
  const show = useCallback(
    (point: Element, pinned: boolean, pointer?: { x: number; y: number }): void => {
      if (active.current?.pinned && !pinned) return
      const detail = active.current?.point === point ? active.current.detail : detailOf(point)
      if (detail === null) return
      if (active.current?.point !== point) {
        active.current?.point.removeAttribute('data-viz-pinned')
        active.current?.point.removeAttribute('aria-describedby')
      }
      point.setAttribute('aria-describedby', id)
      if (pinned) point.setAttribute('data-viz-pinned', 'true')
      refs.setReference(
        pointer && !pinned
          ? {
              contextElement: point,
              getBoundingClientRect: () => ({
                x: pointer.x,
                y: pointer.y,
                top: pointer.y,
                bottom: pointer.y,
                left: pointer.x,
                right: pointer.x,
                width: 0,
                height: 0,
              }),
            }
          : point,
      )
      if (active.current?.point !== point || active.current.pinned !== pinned) {
        active.current = { point, detail, pinned }
        setShown(active.current)
      }
      void update()
    },
    [id, refs, update],
  )
  useEffect(() => {
    hide()
  }, [resetKey, hide])
  useEffect(() => {
    if (shown === null) return
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // A first Escape dismisses the inspection; another can close an expanded visual.
      event.stopImmediatePropagation()
      event.preventDefault()
      hide()
    }
    const outside = (event: globalThis.PointerEvent): void => {
      if (event.target instanceof Node && refs.floating.current?.contains(event.target)) return
      if (
        active.current?.pinned &&
        (!(event.target instanceof Node) ||
          !root.current?.contains(event.target) ||
          !pointOf(event.target))
      )
        hide()
    }
    const scroll = (): void => {
      if (!active.current?.pinned) hide()
    }
    window.addEventListener('keydown', escape, true)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', scroll, true)
    return () => {
      window.removeEventListener('keydown', escape, true)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', scroll, true)
    }
  }, [shown, hide, refs.floating])
  useEffect(
    () => () => {
      active.current?.point.removeAttribute('data-viz-pinned')
      active.current?.point.removeAttribute('aria-describedby')
    },
    [],
  )
  const hover = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'touch' || active.current?.pinned) return
    const point = pointOf(event.target)
    if (point && root.current?.contains(point))
      show(point, false, { x: event.clientX, y: event.clientY })
    else hide()
  }
  const focus = (event: FocusEvent<HTMLDivElement>): void => {
    const point = pointOf(event.target)
    if (point) show(point, false)
  }
  const pin = (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>): void => {
    const point = pointOf(event.target)
    if (!point) return
    if (active.current?.point === point && active.current.pinned) hide()
    else show(point, true)
  }
  return (
    <div
      ref={root}
      className="ari-viz-interactive"
      onPointerMove={hover}
      onPointerLeave={() => {
        if (!active.current?.pinned) hide()
      }}
      onFocus={focus}
      onBlur={() => {
        if (!active.current?.pinned) hide()
      }}
      onClick={pin}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && pointOf(event.target)) {
          event.preventDefault()
          event.stopPropagation()
          pin(event)
        }
      }}
    >
      {children}
      {shown &&
        createPortal(
          <div
            ref={refs.setFloating}
            id={id}
            className="ari-viz-tooltip"
            role="tooltip"
            data-pinned={shown.pinned ? '' : undefined}
            style={{ ...floatingStyles, visibility: isPositioned ? 'visible' : 'hidden' }}
          >
            <div className="ari-viz-tooltip-head">
              <strong>{shown.detail.title}</strong>
              {shown.pinned && <span>Pinned</span>}
            </div>
            {shown.detail.description && <p>{shown.detail.description}</p>}
            {shown.detail.rows && (
              <dl>
                {shown.detail.rows.map((row, i) => (
                  <div key={i}>
                    <dt>
                      {row.color && (
                        <span className="ari-viz-swatch" style={{ background: row.color }} />
                      )}
                      {row.label}
                    </dt>
                    <dd>
                      {typeof row.value === 'number'
                        ? new Intl.NumberFormat(undefined, { maximumSignificantDigits: 21 }).format(
                            row.value,
                          )
                        : row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {shown.detail.note && <p className="ari-viz-tooltip-note">{shown.detail.note}</p>}
            <span className="ari-viz-tooltip-hint">
              {shown.pinned ? 'Click again or press Esc to dismiss' : 'Click or press Enter to pin'}
            </span>
          </div>,
          layerRoot(),
        )}
    </div>
  )
}
