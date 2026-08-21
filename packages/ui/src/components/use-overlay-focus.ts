import { useEffect } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export interface OverlayFocusOptions {
  /** Whether the overlay is currently open. */
  active: boolean
  /** Ref to the panel that focus should be trapped within. */
  panelRef: RefObject<HTMLElement | null>
  /** Called when Escape is pressed; must be referentially stable while open. */
  onEscape: () => void
}

/**
 * Shared keyboard/focus machinery for Dialog and Sheet: moves focus to the
 * first focusable element in the panel on open, cycles Tab within it, reports
 * Escape presses and restores focus to the previously focused element on
 * close or unmount.
 */
export function useOverlayFocus({ active, panelRef, onEscape }: OverlayFocusOptions): void {
  useEffect(() => {
    if (!active) return
    const panel = panelRef.current
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusables = () =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : []

    ;(focusables()[0] ?? panel)?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onEscape()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      const current = document.activeElement
      const inside = current instanceof HTMLElement && panel?.contains(current)
      if (event.shiftKey) {
        if (!inside || current === first) {
          event.preventDefault()
          last.focus()
        }
        return
      }
      if (!inside || current === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [active, panelRef, onEscape])
}
