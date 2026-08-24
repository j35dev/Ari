export interface AppShortcut {
  /** Stable logical action id, shared with the future keybindings layer. */
  id: string
  /** Human-readable row label. */
  label: string
  /**
   * Logical chord; `Mod` resolves to Ctrl or Cmd per platform at render time.
   * Chords without `Mod` render literally (Ctrl+Tab is cross-platform).
   */
  chord: string
}

/**
 * The app's global shortcut map — single source for the Keybindings settings
 * table, the cheat-sheet overlay, and the runtime window-level key handler.
 */
export const APP_SHORTCUTS: readonly AppShortcut[] = [
  { id: 'TogglePalette', label: 'Toggle command palette', chord: 'Mod+K' },
  { id: 'NewSession', label: 'New session', chord: 'Mod+N' },
  { id: 'ContentSearch', label: 'Search project content', chord: 'Mod+Shift+F' },
  { id: 'JumpToSession', label: 'Jump to session 1–9', chord: 'Mod+1…9' },
  { id: 'NextSession', label: 'Next session', chord: 'Ctrl+Tab' },
  { id: 'PreviousSession', label: 'Previous session', chord: 'Ctrl+Shift+Tab' },
  { id: 'ClosePalette', label: 'Close palette', chord: 'Escape' },
]
