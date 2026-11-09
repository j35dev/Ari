import type { JSX } from 'react'
import './aria-mark.css'

const STATE_LABEL = {
  idle: 'Ready',
  thinking: 'Thinking',
  working: 'Sessions running',
  attention: 'Needs you',
} as const

const EYES = {
  idle: { width: 2.3, height: 3.2 },
  thinking: { width: 2.3, height: 2.7 },
  working: { width: 2.7, height: 1.8 },
  attention: { width: 2.8, height: 4.2 },
} as const

/** A flat lion cub; the eyes stay legible when sidebar sizes omit its tiny nose. */
export function AriaMark(props: {
  size?: number
  state?: 'idle' | 'thinking' | 'working' | 'attention'
  className?: string
  title?: string
}): JSX.Element {
  const { size = 16, state = 'idle', className, title = 'Aria' } = props
  const small = size <= 16
  const eyes = EYES[state]

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={title}
      aria-description={STATE_LABEL[state]}
      focusable="false"
      data-state={state}
      data-small={small}
      className={['ari-aria-mark', className].filter(Boolean).join(' ')}
    >
      <title>{title}</title>
      <g className="ari-aria-mark-ears ari-aria-mark-mane">
        <ellipse className="ari-aria-mark-ear-left" cx="5.8" cy="6" rx="2.7" ry="2.5" />
        <ellipse cx="18.2" cy="6" rx="2.7" ry="2.5" />
      </g>
      <path className="ari-aria-mark-mane" d="M8 3H16L21 8V17L16 22H8L3 17V8Z" />
      <circle className="ari-aria-mark-face" cx="12" cy="12.7" r="6.2" />
      <g className="ari-aria-mark-eyes ari-aria-mark-ink">
        {[9.3, 14.7].map((cx) => (
          <rect
            key={cx}
            x={cx - eyes.width / 2}
            y={11.5 - eyes.height / 2}
            width={eyes.width}
            height={eyes.height}
            rx="0.55"
          />
        ))}
      </g>
      {!small && <path className="ari-aria-mark-ink" d="M10.8 15.7H13.2L12 17.3Z" />}
    </svg>
  )
}
