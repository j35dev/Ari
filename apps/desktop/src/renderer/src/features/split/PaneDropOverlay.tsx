import type { PaneDropTarget } from './use-pane-drop'

/** Where each target's overlay sits inside the pane it covers. */
const PLACEMENT: Record<PaneDropTarget, string> = {
  fill: 'inset-0',
  left: 'inset-y-0 left-0 w-1/2',
  right: 'inset-y-0 right-0 w-1/2',
  above: 'inset-x-0 top-0 h-1/2',
  below: 'inset-x-0 bottom-0 h-1/2',
}

/**
 * The translucent half-pane that shows where a dragged session would land —
 * whichever half the pointer is nearest, or the whole pane when the drop fills
 * it (a blank pane, or a swap). Purely a preview: the drop handlers sit on the
 * pane, not here.
 */
export function PaneDropOverlay({ target }: { target: PaneDropTarget | null }) {
  if (target === null) return null
  return (
    <div
      aria-hidden
      data-drop-target={target}
      className={`pointer-events-none absolute rounded-sm border border-accent/40 bg-accent/15 ${PLACEMENT[target]}`}
    />
  )
}
