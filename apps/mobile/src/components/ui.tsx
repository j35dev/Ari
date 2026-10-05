import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * The shared pieces every destination is built from.
 *
 * One module because neither earns a file alone: a search field and the
 * bottom-sheet shell. All styling is design tokens; all touch targets clear
 * 44px.
 */

/** A rounded search field with a magnifier, and an optional filter toggle. */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  filterActive,
  onFilterPress,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
  filterActive?: boolean
  onFilterPress?: () => void
}): ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-1 px-3">
      <svg
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        aria-hidden
        className="shrink-0 text-fg-subtle"
      >
        <circle cx="9" cy="9" r="5.5" />
        <path d="m13.5 13.5 3 3" />
      </svg>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type="search"
        aria-label={label}
        className="h-11 min-w-0 flex-1 bg-transparent text-fg placeholder:text-fg-subtle"
      />
      {onFilterPress !== undefined && (
        <button
          type="button"
          onClick={onFilterPress}
          aria-label="Toggle archived sessions"
          aria-pressed={filterActive === true}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${
            filterActive === true ? 'text-accent' : 'text-fg-subtle'
          }`}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M3 6h14" />
            <circle cx="8" cy="6" r="2" fill="var(--ari-surface-1)" />
            <path d="M3 14h14" />
            <circle cx="12.5" cy="14" r="2" fill="var(--ari-surface-1)" />
          </svg>
        </button>
      )}
    </div>
  )
}

/** Dragging the grip further than this closes the sheet; less, and it settles back. */
const DISMISS_PX = 96

/** A bottom sheet: the backdrop or a downward drag dismisses, the panel holds the content. */
export function BottomSheet({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}): ReactNode {
  const panel = useRef<HTMLDivElement>(null)
  const close = useEffectEvent(onClose)
  const start = useRef<number | null>(null)
  const [drag, setDrag] = useState(0)
  useEffect(() => {
    const previous = document.activeElement
    const getControls = (): HTMLElement[] =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]',
        ) ?? [],
      )
    getControls()[0]?.focus()
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
      if (event.key !== 'Tab') return
      const controls = getControls()
      const first = controls[0]
      const last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-bg/60 backdrop-blur-[2px]"
      />
      <div
        ref={panel}
        className={`sheet-rise relative flex max-h-[85%] min-h-0 flex-col overflow-hidden rounded-t-3xl border-t border-border bg-surface-0 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] ${drag > 0 ? '' : 'transition-transform duration-200'}`}
        {...(drag > 0 ? { style: { transform: `translateY(${drag}px)` } } : {})}
      >
        <div
          data-testid="sheet-grip"
          className="shrink-0 touch-none pt-2"
          onTouchStart={(event) => {
            start.current = event.touches[0]?.clientY ?? null
          }}
          onTouchMove={(event) => {
            if (start.current !== null)
              setDrag(Math.max(0, (event.touches[0]?.clientY ?? start.current) - start.current))
          }}
          onTouchEnd={() => {
            start.current = null
            if (drag > DISMISS_PX) onClose()
            setDrag(0)
          }}
        >
          <div aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-border-strong" />
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 py-2">
          <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center rounded-full text-fg-muted"
            aria-label="Close panel"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}
