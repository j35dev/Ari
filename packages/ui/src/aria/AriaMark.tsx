import { useId } from 'react'
import type { JSX } from 'react'
import './aria-mark.css'

const STATE_LABEL = {
  idle: 'Ready',
  thinking: 'Thinking',
  working: 'Sessions running',
  attention: 'Needs you',
} as const

/** A small ember from Ari's awaken motif; no filters so the silhouette stays sharp at 12px. */
export function AriaMark(props: {
  size?: number
  state?: 'idle' | 'thinking' | 'working' | 'attention'
  className?: string
  title?: string
}): JSX.Element {
  const { size = 16, state = 'idle', className, title = 'Aria' } = props
  const id = `ari-mark-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`
  const small = size <= 16

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
      <defs>
        <radialGradient id={id} cx="30%" cy="20%" r="95%">
          <stop className="ari-aria-mark-top" offset="0" />
          <stop className="ari-aria-mark-middle" offset="0.5" />
          <stop className="ari-aria-mark-bottom" offset="1" />
        </radialGradient>
      </defs>
      <g className="ari-aria-mark-body">
        <path
          className="ari-aria-mark-rim"
          fill={`url(#${id})`}
          d="M12 3.2C16 3.4 20.5 9.2 20.2 14.1C19.9 18.6 16.3 21 11.7 20.4C7.3 19.9 3.4 17.2 3.7 12.9C4 8.3 8.2 3.2 12 3.2Z"
        />
        <path
          className="ari-aria-mark-glint"
          d="M7.1 10.7C7.5 8.2 9.5 5.9 11.9 5.6C10.4 6.9 8.9 8.5 8.2 10.9C7.9 11.9 6.9 11.7 7.1 10.7Z"
        />
        {state === 'thinking' && (
          <path
            className="ari-aria-mark-core"
            d="M12.3 9.6C15.5 9.9 17.1 13 15.1 15.9"
            fill="none"
            strokeWidth={small ? 2.1 : 1.5}
            strokeLinecap="round"
          />
        )}
      </g>
      {state === 'working' && (
        <g className="ari-aria-mark-wake" fill="none" strokeLinecap="round" strokeWidth="1.6">
          <path d="M7 21.3C9.4 22.3 13.1 22.7 16 21.5" />
          <path d="M19.8 18.8L21.4 16.1" />
        </g>
      )}
      {state === 'attention' && (
        <circle className="ari-aria-mark-attention" cx="19.2" cy="5.3" r="2.5" strokeWidth="1.6" />
      )}
    </svg>
  )
}
