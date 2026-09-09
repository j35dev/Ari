export type ContextMarkVariant = 'project' | 'unfiled' | 'archived'

export interface ContextMarkProps {
  variant: ContextMarkVariant
  /** True while a session inside this bucket is the active one. */
  active?: boolean
}

/** Rounded cursor block shared by project and unfiled contexts. */
const BLOCK_PATH = 'M4 2.5 H8 A2 2 0 0 1 10 4.5 V7.5 A2 2 0 0 1 8 9.5 H4 A2 2 0 0 1 2 7.5 V4.5 A2 2 0 0 1 4 2.5 Z'

/** Same block with the bottom edge scooped down into a shallow tray (archived). */
const SCOOP_PATH = 'M4 2.5 H8 A2 2 0 0 1 10 4.5 V7.6 Q10 10.6 6 10.6 Q2 10.6 2 7.6 V4.5 A2 2 0 0 1 4 2.5 Z'

/**
 * Context caret family — the replacement for the hue-tinted iris tiles. One
 * small neutral mark per bucket (project / unfiled / archived); when a session
 * inside the bucket is active the mark fills with the theme accent. That fill,
 * plus the active session row's accent chip, is the whole "you are here"
 * signal. `aria-hidden`: the row text carries the accessible name.
 */
export function ContextMark({ variant, active = false }: ContextMarkProps) {
  const d = variant === 'archived' ? SCOOP_PATH : BLOCK_PATH
  const dashed = variant === 'unfiled' && !active
  return (
    <span
      aria-hidden
      data-context-mark={variant}
      data-active={active ? '' : undefined}
      className={`grid size-5 shrink-0 place-items-center ${active ? 'text-accent' : 'text-fg-subtle'}`}
    >
      <svg width="12" height="12" viewBox="0 0 12 12">
        <path
          d={d}
          fill={active ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth={active ? 0 : 1.4}
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeDasharray={dashed ? '2.1 1.5' : undefined}
        />
      </svg>
    </span>
  )
}
