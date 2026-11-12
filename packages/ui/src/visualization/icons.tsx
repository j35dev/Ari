import type { ReactNode } from 'react'

/** 16px line icons for a visual's toolbar, drawn in the button's text colour. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const TableIcon = () => (
  <Icon>
    <path d="M4 2.5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" />
    <path d="M2 6.5h12M6.5 6.5v7" />
  </Icon>
)

export const CopyIcon = () => (
  <Icon>
    <path d="M7.25 5.5h4.5a1.75 1.75 0 0 1 1.75 1.75v4.5a1.75 1.75 0 0 1-1.75 1.75h-4.5a1.75 1.75 0 0 1-1.75-1.75v-4.5A1.75 1.75 0 0 1 7.25 5.5Z" />
    <path d="M10.5 5.5V4.25A1.75 1.75 0 0 0 8.75 2.5h-4.5A1.75 1.75 0 0 0 2.5 4.25v4.5c0 .97.78 1.75 1.75 1.75H5.5" />
  </Icon>
)

export const CheckIcon = () => (
  <Icon>
    <path d="m3 8.5 3.25 3.25L13 5" />
  </Icon>
)

export const ExpandIcon = () => (
  <Icon>
    <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
  </Icon>
)

/** Bars turned on their side: switches a bar chart between columns and rows. */
export const FlipIcon = () => (
  <Icon>
    <path d="M2.5 3.5h6M2.5 8h10M2.5 12.5h4" />
  </Icon>
)
