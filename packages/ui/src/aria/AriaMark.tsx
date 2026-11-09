import type { JSX } from 'react'
import './aria-mark.css'

const STATE_LABEL = {
  idle: 'Ready',
  thinking: 'Thinking',
  working: 'Sessions running',
  attention: 'Needs you',
} as const

/** A geometric lowercase a; the circle and stem carry activity independently. */
export function AriaMark(props: {
  size?: number
  state?: 'idle' | 'thinking' | 'working' | 'attention'
  className?: string
  title?: string
}): JSX.Element {
  const { size = 16, state = 'idle', className, title = 'Aria' } = props
  const small = size <= 16

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={small ? 2.6 : 2.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={title}
      aria-description={STATE_LABEL[state]}
      focusable="false"
      data-state={state}
      data-small={small}
      className={['ari-aria-mark', className].filter(Boolean).join(' ')}
    >
      <title>{title}</title>
      <g transform="translate(1.5 0)">
        <circle
          className="ari-aria-mark-circle"
          cx="10.5"
          cy="12.5"
          r="7"
          pathLength={state === 'thinking' ? 100 : undefined}
          strokeDasharray={state === 'thinking' ? '78 22' : undefined}
        />
        <path className="ari-aria-mark-stem" d="M17.5 5.5V19.5" />
      </g>
    </svg>
  )
}
