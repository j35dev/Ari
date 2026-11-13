import { useState, type ReactNode } from 'react'
import { Monitor, PanelLeftOpen, PanelRight } from 'lucide-react'
import { rpc } from '../lib/rpc'
import { cx, iconButton, iconButtonActive } from '../lib/recipes'

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

/**
 * The window's top edge: a drag strip on the chrome, with no fill or border of
 * its own. The leading zone is the sidebar's header (wordmark, search,
 * collapse) and is exactly as wide as the sidebar. The sidebar already marks
 * the open session, so the bar does not repeat its name; a remote session
 * names its machine. At the trailing edge are the provider's usage, the Git
 * control and one toggle for the panel docked beside the session; the panel's
 * own tabs choose between changes, files, the terminal and the browser.
 *
 * The bar is a size container. As the window narrows its pieces give up their
 * words in order (provider name, branch, Git action label) and keep
 * their icons, so nothing is squeezed to a letter or pushed under the window
 * buttons.
 */
export function Titlebar({
  panelOpen = false,
  onTogglePanel,
  onExpandSidebar,
  minimal = false,
  git,
  usage,
  leading,
  leadingWidth,
  machineLabel,
}: {
  /** The panel beside the session is showing. */
  panelOpen?: boolean
  /** Opens the panel on the tab last used, or closes it. Absent hides the toggle. */
  onTogglePanel?: () => void
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
  /** The immutable remote owner of the session/tools currently shown. */
  machineLabel?: string
}) {
  const [platform] = useState<TitlebarPlatform>(detectPlatform)
  const [maximized, setMaximized] = useState(false)

  return (
    <header
      className="@container flex h-[var(--ari-titlebar-height)] shrink-0 items-center"
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

      {machineLabel && !minimal ? (
        <span
          aria-label="Session machine"
          title={machineLabel}
          className="flex min-w-0 max-w-56 items-center gap-1.5 pl-3 text-sm text-fg-subtle"
        >
          <Monitor size={14} strokeWidth={1.7} aria-hidden className="shrink-0" />
          <span className="truncate">{machineLabel}</span>
        </span>
      ) : null}

      <div className="min-w-4 flex-1" />
      {usage && !minimal ? (
        <div className="mr-1 shrink-0" style={NO_DRAG}>
          {usage}
        </div>
      ) : null}
      {git ? (
        <div className="mr-1 shrink-0" style={NO_DRAG}>
          {git}
        </div>
      ) : null}

      {onTogglePanel ? (
        <nav aria-label="Workspace" className="flex shrink-0 items-center pr-2" style={NO_DRAG}>
          <button
            type="button"
            aria-label={panelOpen ? 'Close panel' : 'Open panel'}
            aria-pressed={panelOpen}
            title={panelOpen ? 'Close panel' : 'Open panel: changes, files, terminal, browser'}
            onClick={onTogglePanel}
            className={cx(iconButton, panelOpen && iconButtonActive)}
          >
            <PanelRight size={16} strokeWidth={1.7} aria-hidden />
          </button>
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
        <div className="shrink-0" style={{ width: 138 }} />
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
