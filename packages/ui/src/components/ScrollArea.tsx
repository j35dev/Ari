import type { ComponentProps } from 'react'

export type ScrollAreaProps = ComponentProps<'div'>

/**
 * Native scrolling container. Scrolling stays on the platform scroller for
 * performance; only the scrollbar chrome is themed via the `ari-scroll`
 * rules in `@ari/ui/scroll-area.css`.
 */
export function ScrollArea({ className, children, ...rest }: ScrollAreaProps) {
  return (
    <div
      className={['ari-scroll overflow-auto', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </div>
  )
}
