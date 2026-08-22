export interface TerminalA11yProps {
  /** Current terminal title; each change re-announces politely. */
  title: string
}

/**
 * Invisible live region for the terminal pane (M10.9): assistive tech hears
 * title changes that would otherwise exist only as visual tab labels. Render
 * alongside the pane; it never paints or intercepts pointers.
 */
export function TerminalA11y({ title }: TerminalA11yProps) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      Terminal: {title}
    </div>
  )
}
