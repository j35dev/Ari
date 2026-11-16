/**
 * The red-leaning action of the approval surfaces. Everything else here uses the
 * shared recipes; this exists because abandoning a plan throws work away. The
 * approval card styles its own refusal inside its shadow root.
 */

const BASE =
  'inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/** Abandoning a plan: red text, no fill, so it never outweighs the primary action. */
export const destructiveButton = `${BASE} text-danger hover:bg-danger-subtle`
