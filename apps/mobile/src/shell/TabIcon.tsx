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
      {id === 'now' && (
        <>
          <rect x="2.5" y="3.5" width="15" height="10" rx="2" />
          <path d="M7 16.5h6M10 13.5v3" />
        </>
      )}
      {id === 'sessions' && (
        <path d="M16.5 9.5a5 5 0 0 1-5 5H6l-3.5 3V5a5 5 0 0 1 5-5h4a5 5 0 0 1 5 4.5v5Z" />
      )}
      {id === 'projects' && (
        <path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.5l1.8 2H16a1.5 1.5 0 0 1 1.5 1.5V14A1.5 1.5 0 0 1 16 15.5H4A1.5 1.5 0 0 1 2.5 14V5.5Z" />
      )}
      {id === 'settings' && (
        <>
          <circle cx="5" cy="10" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="15" cy="10" r="1.6" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  )
}
