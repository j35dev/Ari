import { useMemo } from 'react'
import {
  FolderGit2,
  GitPullRequest,
  Images,
  MessageSquare,
  Settings,
  TerminalSquare,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/** A runnable entry in the command palette. */
export interface PaletteCommand {
  /** Stable unique identifier. */
  id: string
  /** Display label; also the fuzzy-search target. */
  label: string
  /** Optional keyboard hint rendered as a kbd chip. */
  hint?: string
  /** Optional leading icon. */
  icon?: LucideIcon
  /** Invoked when the command is chosen. */
  run: () => void
}

/** Views the palette can navigate to; mirrors the shell rail targets. */
export type NavigableView = 'sessions' | 'projects' | 'terminal' | 'changes' | 'settings'

/** Callbacks the app command list is built from. */
export interface CommandsContext {
  onNavigate: (view: NavigableView) => void
  onOpenGallery: () => void
}

/**
 * Pure factory for the app command list: rail navigation targets and the
 * component gallery.
 */
export function buildAppCommands(ctx: CommandsContext): PaletteCommand[] {
  return [
    {
      id: 'nav.sessions',
      label: 'Go to Sessions',
      icon: MessageSquare,
      run: () => ctx.onNavigate('sessions'),
    },
    {
      id: 'nav.projects',
      label: 'Go to Projects',
      icon: FolderGit2,
      run: () => ctx.onNavigate('projects'),
    },
    {
      id: 'nav.terminal',
      label: 'Go to Terminal',
      icon: TerminalSquare,
      run: () => ctx.onNavigate('terminal'),
    },
    {
      id: 'nav.changes',
      label: 'Go to Changes',
      icon: GitPullRequest,
      run: () => ctx.onNavigate('changes'),
    },
    {
      id: 'nav.settings',
      label: 'Go to Settings',
      icon: Settings,
      run: () => ctx.onNavigate('settings'),
    },
    {
      id: 'view.gallery',
      label: 'Browse component gallery',
      icon: Images,
      run: () => ctx.onOpenGallery(),
    },
  ]
}

/** Memoized app command list built from the passed context object. */
export function useCommands(ctx: CommandsContext): PaletteCommand[] {
  const { onNavigate, onOpenGallery } = ctx
  return useMemo(
    () => buildAppCommands({ onNavigate, onOpenGallery }),
    [onNavigate, onOpenGallery],
  )
}
