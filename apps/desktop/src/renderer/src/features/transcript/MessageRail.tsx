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
 *
 * Each dot owns an equal slot of the rail. Slots shrink before the rail grows,
 * so a long session packs into a finer dotted line rather than running past
 * the pane it belongs to.
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
      className="absolute bottom-6 right-1.5 top-6 z-10 flex w-4 flex-col"
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
            className={`group relative flex h-4.5 min-h-0 w-full shrink items-center justify-center focus-visible:outline-none ${
              isActive || isHovered ? 'z-10' : ''
            }`}
          >
            <span
              aria-hidden="true"
              className={`aspect-square shrink-0 rounded-full transition-colors duration-150 group-focus-visible:ring-2 group-focus-visible:ring-accent-ring ${
                isActive || isHovered ? 'h-1.5' : 'h-[clamp(2px,60%,6px)]'
              } ${isActive ? 'bg-accent' : isHovered ? 'bg-fg-subtle' : 'bg-surface-3'}`}
            />
            {isHovered ? (
              <span
                role="tooltip"
                className="pointer-events-none absolute right-5 top-0 w-64 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 shadow-2"
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
