import type { JSX } from 'react'

export function AriaMark(props: {
  size?: number
  state?: 'idle' | 'thinking' | 'working' | 'attention'
  className?: string
  title?: string
}): JSX.Element {
  const { size = 16, state = 'idle', className, title } = props
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      data-aria-state={state}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <circle cx="8" cy="8" r="6" fill="currentColor" />
    </svg>
  )
}
