import { useState, type ReactNode } from 'react'
import { FileDiff, Folder, Globe, ListTree, PanelLeftOpen, TerminalSquare } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { rpc } from '../lib/rpc'
import { cx, iconButton, iconButtonActive } from '../lib/recipes'
import type { SidebarNavId } from './Sidebar'

/**
 * The panels a session can dock beside itself. Usage and settings are app
 * destinations, not panels, and live in the sidebar footer.
 */
/** A tool the titlebar can toggle: a workspace panel, or Aria's overview. */
export type TitlebarToolId = SidebarNavId | 'overview'

interface TitlebarTool {
  id: Exclude<TitlebarToolId, 'session'>
  label: string
  icon: LucideIcon
}

/** Offered only beside Aria's chat: the sessions she is leading. */
const OVERVIEW_TOOL: TitlebarTool = { id: 'overview', label: 'Overview', icon: ListTree }

const TITLEBAR_TOOLS: TitlebarTool[] = [
  { id: 'changes', label: 'Review changes', icon: FileDiff },
  { id: 'files', label: 'Files', icon: Folder },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'browser', label: 'Browser', icon: Globe },
]

type TitlebarPlatform = 'win32' | 'darwin' | 'linux' | 'other'

/** hiddenInset traffic lights occupy ~70px on the leading edge (PLAN §8). */
const MACOS_TRAFFIC_LIGHT_PAD = 'pl-[76px]'

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function detectPlatform(): TitlebarPlatform {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('windows')) return 'win32'
  if (ua.includes('mac')) return 'darwin'
  if (ua.includes('linux') || ua.includes('x11')) return 'linux'
  return 'other'
}

/** Where the user is: the project, then the thing open in it. */
export interface TitlebarPlace {
  /** The project or section the title belongs to; null when there is none. */
  context: string | null
  title: string
}

/**
 * The window's top edge: a drag strip on the chrome, with no fill or border of
 * its own. The leading zone is the sidebar's header (wordmark, search,
 * collapse) and is exactly as wide as the sidebar; after it comes the place,
 * and at the trailing edge the provider's usage, the Git control and the
 * panel toggles.
 */
export function Titlebar({
  activeTool,
  onSelectTool,
  changeCount = null,
  onExpandSidebar,
  minimal = false,
  git,
  usage,
  leading,
  leadingWidth,
  place = null,
  overview = false,
}: {
  activeTool?: TitlebarToolId | null
  onSelectTool?: (id: TitlebarToolId) => void
  /** Working-tree file count for the Review changes tool. Null hides the badge. */
  changeCount?: number | null
  onExpandSidebar?: () => void
  /** Setup keeps only the native window controls. */
  minimal?: boolean
  /** The Git control for the active workspace; absent outside a repository. */
  git?: ReactNode
  /** The provider allowance for the active session: a ring, the provider, how much is used. */
  usage?: ReactNode
  /** The sidebar's header, shown while the sidebar is open. */
  leading?: ReactNode
  /** Width of the leading zone in pixels; follows the sidebar as it resizes. */
  leadingWidth?: number
  place?: TitlebarPlace | null
  /** Offer Aria's overview panel beside the workspace panels. */
  overview?: boolean
}) {
  const [platform] = useState<TitlebarPlatform>(detectPlatform)
  const [maximized, setMaximized] = useState(false)

  return (
    <header
      className="flex h-[var(--ari-titlebar-height)] shrink-0 items-center"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {leading !== undefined && !minimal ? (
        <div
          className={cx('min-w-0 shrink-0', platform === 'darwin' && MACOS_TRAFFIC_LIGHT_PAD)}
          style={{ width: leadingWidth }}
        >
          {leading}
        </div>
      ) : (
        <div
          className={`flex items-center gap-2 ${platform === 'darwin' ? MACOS_TRAFFIC_LIGHT_PAD : 'pl-3'}`}
        >
          {onExpandSidebar !== undefined ? (
            <button
              type="button"
              aria-label="Expand sidebar"
              title="Expand sidebar (Ctrl+B)"
              onClick={onExpandSidebar}
              className={iconButton}
              style={NO_DRAG}
            >
              <PanelLeftOpen size={16} strokeWidth={1.7} aria-hidden />
            </button>
          ) : null}
        </div>
      )}

      {place !== null && !minimal ? (
        <div className="flex min-w-0 items-center gap-2 pl-3 text-sm text-fg-subtle">
          {place.context !== null ? (
            <>
              <span className="max-w-48 truncate">{place.context}</span>
              <span aria-hidden className="opacity-50">
                /
              </span>
            </>
          ) : null}
          <span className="min-w-0 truncate font-medium text-fg">{place.title}</span>
        </div>
      ) : null}

      <div className="min-w-4 flex-1" />
      {usage && !minimal ? (
        <div className="mr-1 min-w-0 shrink" style={NO_DRAG}>
          {usage}
        </div>
      ) : null}
      {git ? (
        <div className="mr-1 shrink-0" style={NO_DRAG}>
          {git}
        </div>
      ) : null}

      {onSelectTool ? (
        <nav
          aria-label="Workspace"
          className="flex shrink-0 items-center gap-0.5 pr-2"
          style={NO_DRAG}
        >
          {(overview ? [OVERVIEW_TOOL, ...TITLEBAR_TOOLS] : TITLEBAR_TOOLS).map((item) => {
            const Icon = item.icon
            const selected = item.id === activeTool
            const count =
              item.id === 'changes' && changeCount !== null && changeCount > 0 ? changeCount : null
            const label = count === null ? item.label : `${item.label}, ${count} files changed`
            return (
              <button
                key={item.id}
                type="button"
                aria-label={label}
                aria-pressed={selected}
                title={label}
                onClick={() => onSelectTool(item.id)}
                className={cx(
                  iconButton,
                  count !== null && 'w-auto gap-1.5 px-2',
                  selected && iconButtonActive,
                )}
              >
                <Icon size={16} strokeWidth={1.7} aria-hidden />
                {count !== null ? (
                  <span className="text-xs tabular-nums text-fg-muted">
                    {count > 99 ? '99+' : count}
                  </span>
                ) : null}
              </button>
            )
          })}
        </nav>
      ) : null}

      {platform === 'linux' ? (
        <div className="flex h-full items-stretch" style={NO_DRAG}>
          <WindowButton label="Minimize" onClick={() => void rpc.invoke('window.minimize')}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </WindowButton>
          <WindowButton
            label={maximized ? 'Restore' : 'Maximize'}
            onClick={() => {
              void rpc.invoke('window.toggleMaximize').then((r) => setMaximized(r.maximized))
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <rect
                x="1.5"
                y="1.5"
                width="7"
                height="7"
                stroke="currentColor"
                fill="none"
                strokeWidth="1.2"
              />
            </svg>
          </WindowButton>
          <WindowButton label="Close" danger onClick={() => void rpc.invoke('window.close')}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </WindowButton>
        </div>
      ) : // Reserve space for native Windows overlay buttons.
      platform === 'win32' ? (
        <div style={{ width: 138 }} />
      ) : (
        <div className="w-2" />
      )}
    </header>
  )
}

function WindowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`flex w-11 items-center justify-center text-fg-muted transition-colors ${
        danger ? 'hover:bg-danger hover:text-fg-on-accent' : 'hover:bg-fg/6 hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}
