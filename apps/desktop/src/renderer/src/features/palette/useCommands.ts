import { useMemo } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  FileSearch,
  Folder,
  Gauge,
  GitPullRequest,
  Globe,
  Images,
  Maximize2,
  MessageSquare,
  PanelBottom,
  PanelRight,
  Plus,
  Settings,
  TerminalSquare,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PaneEdge } from '../split/split-layout'
import { GithubMark } from '../github/GithubMark'

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
  'sessions' | 'terminal' | 'browser' | 'changes' | 'settings' | 'files' | 'usage' | 'github'

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

/**
 * What the space commands act on, as the shell sees it: the tab list and which
 * one is active. Absent where no tab strip is mounted, so the gallery and the
 * tests get the navigation list alone.
 */
export interface SpaceCommands {
  /** The tabs, in order, for the "Switch to …" entries. */
  spaces: { id: string; name: string }[]
  /** True while a new tab would be refused at the ceiling. */
  atCeiling: boolean
  /** True while there is only one tab, where closing means nothing. */
  single: boolean
  create: () => void
  close: () => void
  next: () => void
  previous: () => void
  select: (spaceId: string) => void
}

/** Callbacks the app command list is built from. */
export interface CommandsContext {
  onNavigate: (view: NavigableView) => void
  onOpenGallery: () => void
  onOpenSearch: () => void
  panes?: PaneCommands
  spaces?: SpaceCommands
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
 * The space entries: create, cycle, close, and a direct jump per tab. The
 * ceiling entry and the single-tab close are left out where they would be
 * no-ops, the same rule the pane commands follow.
 */
function spaceCommands(spaces: SpaceCommands): PaletteCommand[] {
  const commands: PaletteCommand[] = []
  if (!spaces.atCeiling) {
    commands.push({
      id: 'space.new',
      label: 'New space',
      icon: Plus,
      hint: 'Ctrl+Alt+T',
      run: spaces.create,
    })
  }
  commands.push(
    {
      id: 'space.next',
      label: 'Next space',
      icon: ChevronRight,
      hint: 'Ctrl+PageDown',
      run: spaces.next,
    },
    {
      id: 'space.previous',
      label: 'Previous space',
      icon: ChevronLeft,
      hint: 'Ctrl+PageUp',
      run: spaces.previous,
    },
  )
  if (!spaces.single) {
    commands.push({
      id: 'space.close',
      label: 'Close space',
      icon: X,
      hint: 'Ctrl+Alt+W',
      run: spaces.close,
    })
  }
  spaces.spaces.forEach((space, index) => {
    commands.push({
      id: `space.switch.${space.id}`,
      label: `Switch to ${space.name}`,
      hint: index < 9 ? `Ctrl+Alt+${String(index + 1)}` : undefined,
      run: () => spaces.select(space.id),
    })
  })
  return commands
}

/**
 * Pure factory for the app command list: rail navigation targets, the component
 * gallery, and — when the shell mounts them — the pane and space commands.
 */
export function buildAppCommands(ctx: CommandsContext): PaletteCommand[] {
  const { panes, spaces } = ctx
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
      id: 'nav.browser',
      label: 'Go to Browser',
      icon: Globe,
      run: () => ctx.onNavigate('browser'),
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
      id: 'nav.github',
      label: 'Go to PRs & issues',
      icon: GithubMark,
      run: () => ctx.onNavigate('github'),
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
    ...(spaces === undefined ? [] : spaceCommands(spaces)),
  ]
}

/** Memoized app command list built from the passed context object. */
export function useCommands(ctx: CommandsContext): PaletteCommand[] {
  const { onNavigate, onOpenGallery, onOpenSearch, panes, spaces } = ctx
  return useMemo(
    () => buildAppCommands({ onNavigate, onOpenGallery, onOpenSearch, panes, spaces }),
    [onNavigate, onOpenGallery, onOpenSearch, panes, spaces],
  )
}
