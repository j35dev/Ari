import type { JSX } from 'react'
import './aria-mark.css'

const STATE_LABEL = {
  idle: 'Ready',
  thinking: 'Thinking',
  working: 'Sessions running',
  attention: 'Needs you',
} as const

const EYES = {
  idle: { y: 6, height: 2 },
  thinking: { y: 6, height: 2 },
  working: { y: 7, height: 1 },
  attention: { y: 5, height: 3 },
} as const

/** Block scout's 16px grid stays intact at every size and in every pose. */
export function AriaMark(props: {
  size?: number
  state?: 'idle' | 'thinking' | 'working' | 'attention'
  className?: string
  title?: string
}): JSX.Element {
  const { size = 16, state = 'idle', className, title = 'Aria' } = props
  const eyes = EYES[state]

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      role="img"
      aria-label={title}
      aria-description={STATE_LABEL[state]}
      focusable="false"
      data-state={state}
      className={['ari-aria-mark', className].filter(Boolean).join(' ')}
    >
      <title>{title}</title>
      <g className="ari-aria-mark-frame">
        <rect className="ari-aria-mark-tuft" x="10" y="1" width="2" height="3" />
        <rect x="4" y="2" width="5" height="2" />
        <rect x="2" y="4" width="12" height="7" />
        <rect x="1" y="5" width="1" height="3" />
        <rect x="14" y="6" width="1" height="3" />
        <rect x="3" y="11" width="10" height="2" />
        <rect x="5" y="13" width="6" height="1" />
      </g>
      <rect className="ari-aria-mark-face" x="3" y="5" width="10" height="5" />
      <g className="ari-aria-mark-eyes ari-aria-mark-ink">
        {[5, 9].map((x) => (
          <rect key={x} x={x} y={eyes.y} width="2" height={eyes.height} />
        ))}
      </g>
    </svg>
  )
}
