import type { ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * One pane's chrome: the header from the reference layout, with the focused
 * pane taking the accent treatment the active sidebar row already uses. The
 * shell renders this only when the layout holds more than one pane, so a lone
 * pane keeps the chrome-free view it has always had.
 */
export function PaneFrame({
  paneId,
  title,
  focused,
  onFocus,
  onClose,
  children,
}: {
  paneId: string
  /** The session's name, or null while it is still loading or the pane is blank. */
  title: string | null
  focused: boolean
  onFocus: (paneId: string) => void
  onClose: (paneId: string) => void
  children: ReactNode
}) {
  const label = title ?? 'Empty pane'
  return (
    <section
      aria-label={label}
      // Focus follows the pointer and the keyboard, so a pane is the active one
      // before anything inside it reacts — clicking a composer focuses the pane.
      onPointerDownCapture={() => onFocus(paneId)}
      onFocusCapture={() => onFocus(paneId)}
      className={`flex h-full min-h-0 w-full min-w-0 flex-1 flex-col border ${
        focused ? 'border-accent/40' : 'border-border/60'
      }`}
    >
      <header
        className={`flex h-7 shrink-0 items-center gap-1.5 border-b px-2 ${
          focused ? 'border-accent/25 bg-accent/10' : 'border-border/60'
        }`}
      >
        <span
          className={`min-w-0 flex-1 truncate text-2xs ${
            focused ? 'font-medium text-fg' : 'text-fg-subtle'
          }`}
        >
          {label}
        </span>
        <button
          type="button"
          aria-label={`Close ${label}`}
          title="Close pane"
          onClick={() => onClose(paneId)}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <X size={10} aria-hidden />
        </button>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </section>
  )
}

/**
 * A pane with no session in it. Splitting creates one, and so does moving the
 * session it held into another pane — either way the user fills it by dragging
 * a session in, so the placeholder says so.
 */
export function BlankPane() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1.5 p-4 text-center">
      <p className="text-xs text-fg-subtle">No session in this pane</p>
      <p className="max-w-56 text-2xs text-fg-subtle/70">
        Drag a session in from the sidebar, or right-click the pane for Split right and Split down.
      </p>
    </div>
  )
}
