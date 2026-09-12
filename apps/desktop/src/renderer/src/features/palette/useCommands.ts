import { useMemo } from 'react'
import {
  FileSearch,
  Folder,
  Gauge,
  GitPullRequest,
  Images,
  Maximize2,
  MessageSquare,
  PanelBottom,
  PanelRight,
  Settings,
  TerminalSquare,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PaneEdge } from '../split/split-layout'

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
export type NavigableView =
  | 'sessions'
  | 'terminal'
  | 'changes'
  | 'settings'
  | 'files'
  | 'usage'

/**
 * What the pane commands act on, as the shell sees it: the pane the user is in,
 * and whether there is more than one of them. Absent where no split view is
 * mounted, so the gallery and the tests get the navigation list alone.
 */
export interface PaneCommands {
  /** Splits that pane, leaving the new one blank for a session to land in. */
  split: (edge: PaneEdge) => void
  close: () => void
  toggleZoom: () => void
  /** True while the layout is one pane, where closing and zooming mean nothing. */
  single: boolean
}

/** Callbacks the app command list is built from. */
export interface CommandsContext {
  onNavigate: (view: NavigableView) => void
  onOpenGallery: () => void
  onOpenSearch: () => void
  panes?: PaneCommands
}

/**
 * The split-view entries. A lone pane already fills the area, so its close and
 * zoom would be no-ops — the palette leaves them out rather than listing
 * something that cannot happen.
 */
function paneCommands(panes: PaneCommands): PaletteCommand[] {
  const splits: PaletteCommand[] = [
    {
      id: 'pane.splitRight',
      label: 'Split pane right',
      icon: PanelRight,
      hint: 'Ctrl+\\',
      run: () => panes.split('right'),
    },
    {
      id: 'pane.splitDown',
      label: 'Split pane down',
      icon: PanelBottom,
      hint: 'Ctrl+Shift+\\',
      run: () => panes.split('below'),
    },
  ]
  if (panes.single) return splits
  return [
    ...splits,
    {
      id: 'pane.zoom',
      label: 'Zoom pane',
      icon: Maximize2,
      run: () => panes.toggleZoom(),
    },
    {
      id: 'pane.close',
      label: 'Close pane',
      icon: X,
      run: () => panes.close(),
    },
  ]
}

/**
 * Pure factory for the app command list: rail navigation targets, the component
 * gallery, and — when the shell mounts a split view — the pane commands.
 */
export function buildAppCommands(ctx: CommandsContext): PaletteCommand[] {
  const { panes } = ctx
  return [
    {
      id: 'nav.sessions',
      label: 'Go to Sessions',
      icon: MessageSquare,
      run: () => ctx.onNavigate('sessions'),
    },
    {
      id: 'nav.terminal',
      label: 'Go to Terminal',
      icon: TerminalSquare,
      hint: 'Ctrl+`',
      run: () => ctx.onNavigate('terminal'),
    },
    {
      id: 'nav.changes',
      label: 'Go to Changes',
      icon: GitPullRequest,
      run: () => ctx.onNavigate('changes'),
    },
    {
      id: 'nav.files',
      label: 'Go to Files',
      icon: Folder,
      run: () => ctx.onNavigate('files'),
    },
    {
      id: 'nav.usage',
      label: 'Go to Usage',
      icon: Gauge,
      run: () => ctx.onNavigate('usage'),
    },
    {
      id: 'nav.settings',
      label: 'Go to Settings',
      icon: Settings,
      run: () => ctx.onNavigate('settings'),
    },
    {
      id: 'search.project',
      label: 'Search in project',
      icon: FileSearch,
      hint: 'Ctrl+Shift+F',
      run: () => ctx.onOpenSearch(),
    },
    {
      id: 'view.gallery',
      label: 'Browse component gallery',
      icon: Images,
      run: () => ctx.onOpenGallery(),
    },
    ...(panes === undefined ? [] : paneCommands(panes)),
  ]
}

/** Memoized app command list built from the passed context object. */
export function useCommands(ctx: CommandsContext): PaletteCommand[] {
  const { onNavigate, onOpenGallery, onOpenSearch, panes } = ctx
  return useMemo(
    () => buildAppCommands({ onNavigate, onOpenGallery, onOpenSearch, panes }),
    [onNavigate, onOpenGallery, onOpenSearch, panes],
  )
}
