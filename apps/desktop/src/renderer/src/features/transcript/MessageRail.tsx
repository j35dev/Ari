import { useState } from 'react'

export interface MessageRailEntry {
  key: string
  /** The user's prompt text (hover preview). */
  text: string
}

/**
 * Timeline minimap (T3 parity): one thin tick per user message at the right
 * edge. The tick for the message currently in view is inked and wider;
 * clicking a tick scrolls the transcript to that turn; hovering previews the
 * prompt.
 *
 * The ticks sit in a short centred column, clear of the scrollbar, and stay
 * faint until the pointer reaches the rail. Each tick owns an equal slot;
 * slots shrink before the rail grows, so a long session packs into a finer
 * run of ticks rather than running past the pane it belongs to.
 */
export function MessageRail({
  entries,
  activeKey,
  onJump,
}: {
  entries: MessageRailEntry[]
  activeKey: string | null
  onJump: (key: string) => void
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  if (entries.length < 2) return null

  return (
    <nav
      aria-label="Message timeline"
      className="group/rail absolute right-4 top-1/2 z-pane-chrome flex max-h-[calc(100%-7rem)] w-4 -translate-y-1/2 flex-col py-1"
    >
      {entries.map((entry) => {
        const isActive = entry.key === activeKey
        const isHovered = entry.key === hovered
        return (
          <button
            key={entry.key}
            type="button"
            aria-label={`Jump to message: ${entry.text.slice(0, 60)}`}
            aria-current={isActive ? 'true' : undefined}
            onClick={() => onJump(entry.key)}
            onMouseEnter={() => setHovered(entry.key)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(entry.key)}
            onBlur={() => setHovered(null)}
            className={`group relative flex h-2 min-h-0 w-full shrink items-center justify-end focus-visible:outline-none ${
              isActive || isHovered ? 'z-pane-chrome' : ''
            }`}
          >
            <span
              aria-hidden="true"
              className={`h-0.5 shrink-0 rounded-full transition-[width,background-color] duration-150 group-focus-visible:ring-2 group-focus-visible:ring-accent-ring ${
                isActive
                  ? 'w-3 bg-fg/70'
                  : isHovered
                    ? 'w-3 bg-fg/50'
                    : 'w-2 bg-fg/15 group-hover/rail:bg-fg/30'
              }`}
            />
            {isHovered ? (
              <span
                role="tooltip"
                className="pointer-events-none absolute right-5 top-1/2 w-64 -translate-y-1/2 rounded-xl border border-border-strong bg-surface-1 px-3 py-2 shadow-3"
              >
                <span className="line-clamp-3 block whitespace-pre-wrap break-words text-left text-xs leading-snug text-fg-muted">
                  {entry.text}
                </span>
              </span>
            ) : null}
          </button>
        )
      })}
    </nav>
  )
}
