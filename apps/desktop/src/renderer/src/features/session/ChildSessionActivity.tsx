import type { JournalEvent } from '@ari/contracts/events'

export type ChildEvent = Extract<JournalEvent, { type: `child.session.${string}` }>

/** Durable delegation activity stays with the parent transcript; navigation is explicit. */
export function ChildSessionActivity({
  events,
  onOpen,
}: {
  events: ChildEvent[]
  onOpen?: (id: string) => void
}) {
  if (events.length === 0) return null
  const titles = new Map(
    events.flatMap((event) =>
      event.type === 'child.session.spawned' ? [[event.childSessionId, event.title] as const] : [],
    ),
  )
  return (
    <section
      aria-label="Child session activity"
      className="mx-auto my-4 max-w-3xl border-l border-border pl-3"
    >
      <h3 className="mb-2 font-mono text-2xs uppercase tracking-wider text-fg-subtle">
        Child sessions
      </h3>
      <ol className="space-y-2">
        {events.map((event) => (
          <li
            key={event.seq}
            className="flex flex-wrap items-baseline gap-x-2 text-xs text-fg-muted"
          >
            <button
              type="button"
              disabled={!onOpen}
              onClick={() => onOpen?.(event.childSessionId)}
              className="font-medium text-fg hover:underline"
            >
              {titles.get(event.childSessionId) ?? event.childSessionId}
            </button>
            <span>
              {event.type === 'child.session.spawned'
                ? `Created · ${event.driverKind} · ${event.workspaceKind}`
                : event.type === 'child.session.settled'
                  ? event.stopReason
                  : event.type === 'child.session.stopped'
                    ? 'Stopped'
                    : event.result === 'conflict'
                      ? `Integration conflict: ${event.conflictFiles?.join(', ') ?? ''}`
                      : 'Changes integrated'}
            </span>
            <time
              className="ml-auto font-mono text-2xs text-fg-subtle"
              dateTime={new Date(event.at).toISOString()}
            >
              {new Date(event.at).toLocaleTimeString()}
            </time>
          </li>
        ))}
      </ol>
    </section>
  )
}
