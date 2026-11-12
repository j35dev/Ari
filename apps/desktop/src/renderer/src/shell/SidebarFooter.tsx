import { Gauge, Settings } from 'lucide-react'
import { FocusPill } from '../features/focus'
import { cx, iconButton, iconButtonActive } from '../lib/recipes'
import type { SidebarNavId } from './Sidebar'

/**
 * The foot of the sidebar: the app's own destinations (settings, the usage
 * page, focus). Panels that dock beside a session, and the provider's live
 * usage, are in the titlebar instead.
 */
export function SidebarFooter({
  activeTool,
  onSelectTool,
}: {
  /** Whatever tool is open; only usage and settings are marked here. */
  activeTool?: string | null
  onSelectTool: (id: SidebarNavId) => void
}) {
  return (
    <footer className="flex shrink-0 items-center gap-0.5 px-2.5 pb-2.5 pt-1.5">
      <button
        type="button"
        aria-label="Settings"
        aria-pressed={activeTool === 'settings'}
        title="Settings"
        onClick={() => onSelectTool('settings')}
        className={cx(iconButton, activeTool === 'settings' && iconButtonActive)}
      >
        <Settings size={16} strokeWidth={1.7} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Usage"
        aria-pressed={activeTool === 'usage'}
        title="Usage"
        onClick={() => onSelectTool('usage')}
        className={cx(iconButton, activeTool === 'usage' && iconButtonActive)}
      >
        <Gauge size={16} strokeWidth={1.7} aria-hidden />
      </button>
      <FocusPill />
    </footer>
  )
}
