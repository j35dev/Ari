import { MousePointer2, X } from 'lucide-react'
import { chipLabelFor, removeBrowserPick, type BrowserPick } from './browser-picks'

export function ElementChips({ picks }: { picks: readonly BrowserPick[] }) {
  if (picks.length === 0) return null
  return (
    <div
      className="mx-4 mb-1 flex flex-wrap items-center gap-1"
      aria-label="Selected page elements"
    >
      <span className="text-2xs text-fg-subtle">
        {picks.length} element{picks.length > 1 ? 's' : ''} with your next message:
      </span>
      {picks.map((pick) => (
        <span
          key={pick.id}
          className="flex max-w-64 items-center gap-1 rounded-full border border-accent-subtle bg-accent-subtle px-2 py-0.5 text-2xs text-fg-muted"
          title={pick.element.selector}
        >
          <MousePointer2 size={10} aria-hidden className="shrink-0 text-accent" />
          <span className="min-w-0 truncate font-mono">{chipLabelFor(pick)}</span>
          <button
            type="button"
            aria-label={`Remove ${chipLabelFor(pick)}`}
            onClick={() => removeBrowserPick(pick.id)}
            className="shrink-0 rounded-full text-fg-subtle transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <X size={10} />
          </button>
        </span>
      ))}
    </div>
  )
}
