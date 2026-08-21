import { useMemo } from 'react'
import {
  FolderGit2,
  GitPullRequest,
  Images,
  MessageSquare,
  MoonStar,
  Settings,
  TerminalSquare,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { THEMES, useTheme } from '@ari/ui/theme-provider'
import type { ThemeId } from '@ari/ui/theme-provider'

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

/** Callbacks and theme controls the app command list is built from. */
export interface CommandsContext {
  onNavigate: (view: NavigableView) => void
  onOpenGallery: () => void
  theme: ThemeId
  setTheme: (theme: ThemeId) => void
}

/** The theme following `theme` in the THEMES cycle, wrapping at the end. */
export function nextThemeId(theme: ThemeId): ThemeId {
  const index = THEMES.findIndex((t) => t.id === theme)
  return THEMES[(index + 1) % THEMES.length]!.id
}

/**
 * Pure factory for the app command list: rail navigation targets, the
 * component gallery, and theme cycling.
 */
export function buildAppCommands(ctx: CommandsContext): PaletteCommand[] {
  const next = nextThemeId(ctx.theme)
  const nextLabel = THEMES.find((t) => t.id === next)?.label ?? next
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
    {
      id: 'theme.cycle',
      label: `Switch theme to ${nextLabel}`,
      icon: MoonStar,
      run: () => ctx.setTheme(next),
    },
  ]
}

/** Memoized app command list built from the passed context object. */
export function useCommands(ctx: CommandsContext): PaletteCommand[] {
  const { onNavigate, onOpenGallery, theme, setTheme } = ctx
  return useMemo(
    () => buildAppCommands({ onNavigate, onOpenGallery, theme, setTheme }),
    [onNavigate, onOpenGallery, setTheme, theme],
  )
}

export interface UseAppCommandsInput {
  onNavigate: (view: NavigableView) => void
  onOpenGallery: () => void
}

/**
 * App-shell flavor of `useCommands`: navigation callbacks come from the
 * caller, theme controls are pulled from the ambient ThemeProvider.
 */
export function useAppCommands({ onNavigate, onOpenGallery }: UseAppCommandsInput): PaletteCommand[] {
  const { theme, setTheme } = useTheme()
  return useCommands({ onNavigate, onOpenGallery, theme, setTheme })
}
