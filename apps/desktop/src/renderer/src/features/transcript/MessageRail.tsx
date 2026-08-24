import { useState } from 'react'

export interface MessageRailEntry {
  key: string
  /** The user's prompt text (hover preview). */
  text: string
}

/**
 * Timeline minimap (T3 parity): one dot per user message in a slim right-edge
 * rail. The dot for the message currently in view lights up; clicking a dot
 * scrolls the transcript to that turn; hovering previews the prompt.
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
      className="absolute bottom-6 right-1.5 top-6 z-10 flex w-4 flex-col items-center justify-start gap-1.5"
    >
      {entries.map((entry) => {
        const isActive = entry.key === activeKey
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
            className="group relative flex h-3 w-3 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full transition-colors duration-150 ${
                isActive ? 'bg-accent' : 'bg-surface-3 group-hover:bg-fg-subtle'
              }`}
            />
            {hovered === entry.key ? (
              <span
                role="tooltip"
                className="ari-glass-overlay pointer-events-none absolute right-5 top-0 w-64 rounded-lg border border-border px-2.5 py-1.5 shadow-2"
              >
                <span className="line-clamp-3 block whitespace-pre-wrap break-words text-left text-2xs leading-snug text-fg-muted">
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
