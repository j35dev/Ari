/**
 * Class recipes for Ari's design language (docs/design/ari-design-language.md).
 * One place for the handful of treatments every surface repeats, so a row in
 * the sidebar, a row in a menu and a row in a panel are the same row.
 *
 * Hover and selection are washes of the text colour (`bg-fg/6`, `bg-fg/9`),
 * not surface steps: they read the same on chrome and on the stage.
 *
 * The selected and active recipes are meant to be layered on their base
 * (`cx(row, selected && rowSelected)`). Tailwind orders `text-fg` before
 * `text-fg-muted` in the stylesheet, so they mark the text colour important;
 * otherwise the base's muted ink would win.
 */

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/** 28px icon-only control: titlebar tools, row actions, composer tools. */
export const iconButton = `inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-fg/6 hover:text-fg disabled:pointer-events-none disabled:opacity-40 ${FOCUS}`

/** The same control when it is the pressed/open state of a toggle. */
export const iconButtonActive = 'bg-fg/9 text-fg!'

/** 20px action inside a row, shown on hover. */
export const rowAction = `inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-fg/9 hover:text-fg ${FOCUS}`

/** A 32px list row: sidebar sessions, menu items, panel lists. */
export const row = `flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-[13.5px] text-fg-muted transition-colors hover:bg-fg/5 hover:text-fg ${FOCUS}`

/** The selected or current state of {@link row}. */
export const rowSelected = 'bg-fg/9 text-fg!'

/** Quiet caption above a group of rows. Sentence case, never uppercase. */
export const sectionLabel = 'text-xs text-fg-subtle'

/** A picker that reads as plain text until hovered: model, effort, branch. */
export const textButton = `inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg disabled:pointer-events-none disabled:opacity-50 ${FOCUS}`

/** The one filled action in a group: ink on paper, inverted. Not the accent. */
export const primaryButton = `inline-flex h-7 items-center justify-center gap-1.5 rounded-md bg-fg px-2.5 text-[13px] font-medium text-bg transition-colors hover:bg-fg/90 disabled:pointer-events-none disabled:opacity-40 ${FOCUS}`

/** A secondary action beside a primary one. */
export const outlineButton = `inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-border-strong px-2.5 text-[13px] font-medium text-fg transition-colors hover:bg-fg/6 disabled:pointer-events-none disabled:opacity-40 ${FOCUS}`

/** A tertiary action: text only. */
export const quietButton = `inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg disabled:pointer-events-none disabled:opacity-40 ${FOCUS}`

/** A group of settings or a block of related rows on the stage. */
export const card = 'rounded-xl border border-border bg-surface-1'

/** Floating surface: menus, popovers, pickers. */
export const menu = 'rounded-xl border border-border-strong bg-surface-1 p-1 shadow-3'

/** One item in a {@link menu}. */
export const menuItem = `flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg ${FOCUS}`

/** A tab in a panel header or page switcher. */
export const tab = `inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-fg-subtle transition-colors hover:text-fg ${FOCUS}`

/** The current {@link tab}. */
export const tabSelected = 'bg-fg/9 text-fg!'

/** File names, counts and paths that sit beside prose. */
export const chip =
  'inline-flex h-6 items-center gap-1.5 rounded-md border border-border px-2 font-mono text-xs text-fg-muted'

/** Unread or needs-you count. The only filled accent in the chrome. */
export const countBadge =
  'inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[11px] font-semibold leading-none text-fg-on-accent'

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}
