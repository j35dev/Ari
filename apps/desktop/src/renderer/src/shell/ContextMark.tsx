import { Archive, Folder, FolderOpen, Inbox } from 'lucide-react'
import { cx } from '../lib/recipes'

export type ContextMarkVariant = 'project' | 'unfiled' | 'archived'

export interface ContextMarkProps {
  variant: ContextMarkVariant
  /** True while the bucket is expanded; a project then shows an open folder. */
  open?: boolean
  /** True while a session inside this bucket is the active one. */
  active?: boolean
}

/**
 * The mark that leads a bucket row: a folder for a project (open while its
 * sessions are listed), a tray for Unfiled, an archive box for the shelf.
 * A line icon with no tile behind it, so a list of projects reads as a list
 * of names. It stays neutral; the bucket holding the active session only
 * lifts its ink. `aria-hidden`: the row text carries the accessible name.
 */
export function ContextMark({ variant, open = false, active = false }: ContextMarkProps) {
  const Icon =
    variant === 'archived' ? Archive : variant === 'unfiled' ? Inbox : open ? FolderOpen : Folder
  return (
    <span
      aria-hidden
      data-context-mark={variant}
      data-open={variant === 'project' && open ? '' : undefined}
      data-active={active ? '' : undefined}
      className={cx(
        'grid size-[18px] shrink-0 place-items-center transition-colors',
        active ? 'text-fg-muted' : 'text-fg-subtle',
      )}
    >
      <Icon size={16} strokeWidth={1.6} />
    </span>
  )
}
