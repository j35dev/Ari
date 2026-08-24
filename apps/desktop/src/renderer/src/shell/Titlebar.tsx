import { useEffect, useState } from 'react'
import { rpc } from '../lib/rpc'

/**
 * Custom titlebar, comet-glass style: the bar is a transparent drag strip
 * over the acrylic backdrop (no plate of its own) with a hairline only when
 * it needs to separate from scrolled content. Windows uses native overlay
 * buttons (titleBarOverlay); macOS traffic lights are inset-natively; Linux
 * needs our own controls.
 */
export function Titlebar({ projectLabel }: { projectLabel: string }) {
  const [platform, setPlatform] = useState<'win32' | 'darwin' | 'linux' | 'other'>('other')
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase()
    if (ua.includes('windows')) setPlatform('win32')
    else if (ua.includes('mac')) setPlatform('darwin')
    else if (ua.includes('linux') || ua.includes('x11')) setPlatform('linux')
  }, [])

  return (
    <header
      className="ari-glass flex h-[var(--ari-titlebar-height)] shrink-0 items-center"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-2 pl-3">
        <span className="text-fg text-xs font-semibold tracking-[0.18em]">ARI</span>
        {projectLabel ? (
          <>
            <span className="text-fg-subtle text-xs">/</span>
            <span className="text-fg-muted text-xs">{projectLabel}</span>
          </>
        ) : null}
      </div>

      <div className="flex-1" />

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
              <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" fill="none" strokeWidth="1.2" />
            </svg>
          </WindowButton>
          <WindowButton label="Close" danger onClick={() => void rpc.invoke('window.close')}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </WindowButton>
        </div>
      ) : (
        // Reserve space for native Windows overlay buttons.
        platform === 'win32' ? <div style={{ width: 138 }} /> : <div className="w-16" />
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
