import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'

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

const MENU_WIDTH = 184
const ITEM_HEIGHT = 28
const PADDING = 8

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
      <div className="fixed inset-0 z-[60]" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        style={{ left: position.x, top: position.y, width: MENU_WIDTH }}
        className="ari-glass-overlay fixed z-[61] overflow-hidden rounded-lg border border-border p-1 shadow-2"
      >
        {items.map((item, index) => {
          const Icon = item.icon
          const separated = item.danger && index > 0 && items[index - 1]?.danger !== true
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              aria-disabled={item.disabled === true}
              title={item.disabled === true ? item.disabledReason : undefined}
              onClick={() => {
                if (item.disabled === true) return
                onClose()
                item.onSelect()
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none ${
                separated ? 'mt-1 border-t border-border pt-2' : ''
              } ${
                item.disabled === true
                  ? 'cursor-not-allowed text-fg-subtle opacity-50'
                  : item.danger
                    ? 'text-danger hover:bg-danger-subtle focus-visible:bg-danger-subtle'
                    : 'text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg'
              }`}
            >
              {Icon ? <Icon size={12} aria-hidden className="shrink-0" /> : null}
              <span className="truncate">{item.label}</span>
              {item.disabled === true && item.disabledReason !== undefined ? (
                <span className="sr-only">: {item.disabledReason}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </>,
    document.body,
  )
}

/**
 * Tracks the open context menu for a list of rows: one menu at a time, keyed
 * by row id, with the anchor point from the triggering event.
 */
export function useContextMenu(): {
  openFor: string | null
  anchor: MenuAnchor
  open: (id: string, event: { clientX: number; clientY: number; preventDefault: () => void }) => void
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
