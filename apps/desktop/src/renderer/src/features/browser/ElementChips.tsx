import { MousePointer2, X } from 'lucide-react'
import { chip, cx } from '../../lib/recipes'
import { chipLabelFor, removeBrowserPick, type BrowserPick } from './browser-picks'

/** The chip look without its fixed height, for one that has to wrap a sentence. */
const wrappingChip =
  'inline-flex min-h-6 items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-fg-muted'

export function ElementChips({
  picks,
  sessionId,
}: {
  picks: readonly BrowserPick[]
  sessionId?: string
}) {
  if (picks.length === 0) return null
  return (
    <div
      className="mx-4 mb-1 flex flex-wrap items-center gap-1.5"
      aria-label="Selected page elements"
    >
      <span className="text-xs text-fg-subtle">
        {picks.length} element{picks.length > 1 ? 's' : ''} with your next message:
      </span>
      {picks.map((pick) => {
        const reattach = pick.imageIntent && !pick.image && !pick.imageIntent.ref
        return (
          <span
            key={pick.id}
            className={cx(reattach ? wrappingChip : chip, 'max-w-64')}
            title={pick.element.selector}
          >
            <MousePointer2 size={12} aria-hidden className="shrink-0 text-fg-subtle" />
            <span className="min-w-0 truncate font-mono">{chipLabelFor(pick)}</span>
            {pick.imageIntent && reattach ? (
              <span role="status">
                Reattach {pick.imageIntent.metadata.name} ({pick.imageIntent.metadata.size} bytes) —
                paste or drop the image
              </span>
            ) : null}
            <button
              type="button"
              aria-label={`Remove ${chipLabelFor(pick)}`}
              onClick={() => removeBrowserPick(pick.id, sessionId)}
              className="-mr-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-fg/9 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        )
      })}
    </div>
  )
}
