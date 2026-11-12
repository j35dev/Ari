import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import { layerRoot } from '@ari/ui/layer-root'
import { useOverlayRef } from '@ari/ui/overlay-registry'
import { cx, menu, menuItem } from '../lib/recipes'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: LucideIcon
  /** Renders in danger tone and is separated from the items above it. */
  danger?: boolean
  /** Keeps unavailable capabilities discoverable and explains why. */
  disabled?: boolean
  disabledReason?: string
  onSelect: () => void
}

/** Where a menu was opened, in viewport coordinates. */
export interface MenuAnchor {
  x: number
  y: number
}

/**
 * Anchors a launcher menu just below the control that opened it, the way a
 * dropdown sits under its button. Use with a click event's currentTarget.
 */
export function anchorBelow(element: HTMLElement): MenuAnchor {
  const rect = element.getBoundingClientRect()
  return { x: rect.left, y: rect.bottom + 4 }
}

const MENU_WIDTH = 216
const ITEM_HEIGHT = 32
const PADDING = 8

/** {@link menuItem}'s geometry without its ink, for danger and disabled items. */
const ITEM_FRAME =
  'flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors focus-visible:outline-none'

/**
 * Right-click menu for sidebar rows. Replaces per-row hover icon clusters:
 * rows stay clean, and every action is one right-click away (T3-style).
 *
 * Rendered in a portal so it escapes the sidebar's scroll container, and
 * flipped when it would overflow the viewport. Escape, outside click, scroll
 * and blur all dismiss it.
 */
export function ContextMenu({
  anchor,
  items,
  label,
  onClose,
}: {
  anchor: MenuAnchor
  items: ContextMenuItem[]
  label: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const overlayRef = useOverlayRef()
  const [position, setPosition] = useState<MenuAnchor>(anchor)

  useLayoutEffect(() => {
    const height = items.length * ITEM_HEIGHT + PADDING * 2
    const x = Math.min(anchor.x, window.innerWidth - MENU_WIDTH - PADDING)
    const y = Math.min(anchor.y, window.innerHeight - height - PADDING)
    setPosition({ x: Math.max(PADDING, x), y: Math.max(PADDING, y) })
  }, [anchor, items.length])

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const buttons = Array.from(ref.current?.querySelectorAll('button') ?? [])
      if (buttons.length === 0) return
      const i = buttons.findIndex((b) => b === document.activeElement)
      const delta = e.key === 'ArrowDown' ? 1 : -1
      buttons[(Math.max(i, 0) + delta + buttons.length) % buttons.length]?.focus()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    // Capture phase: a scroll inside the sidebar would otherwise leave the
    // portal menu floating over unrelated rows.
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-context"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={(node) => {
          ref.current = node
          overlayRef(node)
        }}
        role="menu"
        aria-label={label}
        style={{ left: position.x, top: position.y, width: MENU_WIDTH }}
        className={cx(
          menu,
          'ari-enter-pop ari-enter-pop-down fixed z-context origin-top-left overflow-hidden',
        )}
      >
        {items.map((item, index) => {
          const Icon = item.icon
          const separated = item.danger && index > 0 && items[index - 1]?.danger !== true
          return (
            <Fragment key={item.id}>
              {separated ? <div aria-hidden className="mx-1.5 my-1 h-px bg-border" /> : null}
              <button
                type="button"
                role="menuitem"
                aria-disabled={item.disabled === true}
                title={item.disabled === true ? item.disabledReason : undefined}
                onClick={() => {
                  if (item.disabled === true) return
                  onClose()
                  item.onSelect()
                }}
                className={
                  item.disabled === true
                    ? cx(ITEM_FRAME, 'cursor-not-allowed text-fg-subtle opacity-50')
                    : item.danger
                      ? cx(
                          ITEM_FRAME,
                          'text-danger hover:bg-danger-subtle focus-visible:bg-danger-subtle',
                        )
                      : // Arrow keys move real focus, so the focused item also
                        // takes the hover wash.
                        cx(menuItem, 'focus-visible:bg-fg/6 focus-visible:text-fg')
                }
              >
                {Icon ? (
                  <Icon size={14} strokeWidth={1.75} aria-hidden className="shrink-0" />
                ) : null}
                <span className="truncate">{item.label}</span>
                {item.disabled === true && item.disabledReason !== undefined ? (
                  <span className="sr-only">: {item.disabledReason}</span>
                ) : null}
              </button>
            </Fragment>
          )
        })}
      </div>
    </>,
    layerRoot(),
  )
}

/**
 * Tracks the open context menu for a list of rows: one menu at a time, keyed
 * by row id, with the anchor point from the triggering event.
 */
export function useContextMenu(): {
  openFor: string | null
  anchor: MenuAnchor
  open: (
    id: string,
    event: { clientX: number; clientY: number; preventDefault: () => void },
  ) => void
  close: () => void
} {
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<MenuAnchor>({ x: 0, y: 0 })
  return {
    openFor,
    anchor,
    open: (id, event) => {
      event.preventDefault()
      setAnchor({ x: event.clientX, y: event.clientY })
      setOpenFor(id)
    },
    close: () => setOpenFor(null),
  }
}
