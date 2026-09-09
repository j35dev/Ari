import { useState } from 'react'
import {
  Folder,
  Gauge,
  GitPullRequest,
  PanelLeftOpen,
  Settings,
  TerminalSquare,
} from 'lucide-react'
import { rpc } from '../lib/rpc'
import type { SidebarNavId } from './Sidebar'
import type { DriverKind } from '@ari/contracts/common'
import { ProviderUsagePill } from '../features/usage/ProviderUsagePill'
import { FocusPill } from '../features/focus'

const TITLEBAR_TOOLS: {
  id: Exclude<SidebarNavId, 'session'>
  label: string
  icon: typeof Folder
}[] = [
  { id: 'changes', label: 'Changes', icon: GitPullRequest },
  { id: 'files', label: 'Files', icon: Folder },
  { id: 'usage', label: 'Usage', icon: Gauge },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'settings', label: 'Settings', icon: Settings },
]

type TitlebarPlatform = 'win32' | 'darwin' | 'linux' | 'other'

/** hiddenInset traffic lights occupy ~70px on the leading edge (PLAN §8). */
const MACOS_TRAFFIC_LIGHT_PAD = 'pl-[76px]'

function detectPlatform(): TitlebarPlatform {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('windows')) return 'win32'
  if (ua.includes('mac')) return 'darwin'
  if (ua.includes('linux') || ua.includes('x11')) return 'linux'
  return 'other'
}

/**
 * Custom titlebar: drag strip plus compact workspace tools. Tools live here
 * so the session sidebar stays a session list, not a second nav. The leading
 * edge stays empty (macOS hiddenInset traffic lights occupy this corner on
 * darwin); the session's branch lives inside the session space instead.
 */
export function Titlebar({
  activeTool,
  onSelectTool,
  usage,
  onExpandSidebar,
}: {
  activeTool?: SidebarNavId | null
  onSelectTool?: (id: SidebarNavId) => void
  usage?: { sessionId: string | null; kind: DriverKind }
  onExpandSidebar?: () => void
}) {
  const [platform] = useState<TitlebarPlatform>(detectPlatform)
  const [maximized, setMaximized] = useState(false)

  return (
    <header
      className="ari-glass flex h-[var(--ari-titlebar-height)] shrink-0 items-center border-b border-border/50"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        className={`flex items-center gap-2 ${platform === 'darwin' ? MACOS_TRAFFIC_LIGHT_PAD : 'pl-3'}`}
      >
        {onExpandSidebar !== undefined ? (
          <button
            type="button"
            aria-label="Expand sidebar"
            title="Expand sidebar (Ctrl+B)"
            onClick={onExpandSidebar}
            className="flex size-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <PanelLeftOpen size={15} aria-hidden />
          </button>
        ) : null}
      </div>

      <div className="flex-1" />
      <FocusPill />
      {usage ? <ProviderUsagePill {...usage} /> : null}

      {onSelectTool ? (
        <nav
          aria-label="Workspace"
          className="flex items-center gap-1 pr-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {TITLEBAR_TOOLS.map((item) => {
            const Icon = item.icon
            const selected = item.id === activeTool
            return (
              <button
                key={item.id}
                type="button"
                aria-label={item.label}
                aria-pressed={selected}
                title={item.label}
                onClick={() => onSelectTool(item.id)}
                className={`flex size-7 items-center justify-center rounded-lg transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                  selected
                    ? 'bg-accent/15 text-accent border border-accent/25 shadow-sm'
                    : 'text-fg-subtle hover:bg-surface-2/60 hover:text-fg border border-transparent'
                }`}
              >
                <Icon size={14} strokeWidth={selected ? 2 : 1.7} aria-hidden />
              </button>
            )
          })}
        </nav>
      ) : null}

      {platform === 'linux' ? (
        <div
          className="flex h-full items-stretch"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
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
        <div className="w-16" />
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
        danger ? 'hover:bg-danger hover:text-fg-on-accent' : 'hover:bg-glass-hover hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}
