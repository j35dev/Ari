/**
 * The two red-leaning actions of the approval surfaces. Everything else here
 * uses the shared recipes; these exist because a refusal and an abandonment
 * are the only choices in these panels that throw work away.
 */

const BASE =
  'inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/** Declining a request: quiet at rest, red under the pointer. */
export const refuseButton = `${BASE} text-fg-muted hover:bg-danger-subtle hover:text-danger`

/** Abandoning a plan: red text, no fill, so it never outweighs the primary action. */
export const destructiveButton = `${BASE} text-danger hover:bg-danger-subtle`
