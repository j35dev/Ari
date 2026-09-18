import type { ReactNode } from 'react'

/**
 * The four destination glyphs, drawn inline.
 *
 * Inline rather than a package: the mobile bundle has no icon dependency and
 * may not gain one for four glyphs. Twenty-pixel grid, round caps, current
 * color — they inherit the tab's active or idle tone.
 */
export function TabIcon({ id, className }: { id: string; className?: string }): ReactNode {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {id === 'now' && <path d="M11 1.8 4.2 11.4h4.4L8 18.2l6.9-9.6H10.4L11 1.8Z" />}
      {id === 'sessions' && (
        <>
          <path d="M3.5 5.5h13" />
          <path d="M3.5 10h13" />
          <path d="M3.5 14.5h8" />
        </>
      )}
      {id === 'projects' && (
        <path d="M2.8 6.2c0-1 .8-1.9 1.9-1.9h3.2l1.7 2h5.7c1 0 1.9.8 1.9 1.9v6.6c0 1-.8 1.9-1.9 1.9H4.7c-1 0-1.9-.8-1.9-1.9V6.2Z" />
      )}
      {id === 'settings' && (
        <>
          <path d="M3 7h14" />
          <circle cx="8" cy="7" r="2.1" fill="var(--ari-surface-0)" />
          <path d="M3 13.5h14" />
          <circle cx="12.5" cy="13.5" r="2.1" fill="var(--ari-surface-0)" />
        </>
      )}
    </svg>
  )
}
