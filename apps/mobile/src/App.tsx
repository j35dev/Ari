import { useEffect, useState, type ReactNode } from 'react'
import { PairScreen } from './features/pair/PairScreen'
import { AppShell } from './shell/AppShell'
import { takeInvitationFromUrl, useApp } from './lib/app-state'
import { IS_CONNECT_BUILD } from './lib/connect'
import { ConnectScreen } from './features/connect/ConnectScreen'

/** Pairing links also work when an installed PWA receives a new fragment. */
export function App(): ReactNode {
  const app = useApp()
  const [invitation, setInvitation] = useState<string | null>(() =>
    takeInvitationFromUrl(location.href),
  )
  useEffect(() => {
    const receiveInvitation = (): void => {
      const next = takeInvitationFromUrl(location.href)
      if (next !== null) setInvitation(next)
    }
    window.addEventListener('hashchange', receiveInvitation)
    return () => window.removeEventListener('hashchange', receiveInvitation)
  }, [])
  useEffect(() => {
    if (app.connection === 'connected') setInvitation(null)
  }, [app.connection])

  if (IS_CONNECT_BUILD && app.origin === null) return <ConnectScreen />

  if (!app.booted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-fg">
        <p className="text-[15px] font-semibold tracking-tight">Ari</p>
        <p role="status" className="text-sm text-fg-muted">
          {app.origin === null ? 'Starting…' : 'Reaching your computer…'}
        </p>
      </div>
    )
  }
  if (
    app.connection === 'unpaired' ||
    app.connection === 'revoked' ||
    app.connection === 'unknown-device' ||
    app.origin === null ||
    (invitation !== null && app.connection !== 'connected')
  ) {
    return <PairScreen key={invitation} invitationId={invitation} />
  }
  return <AppShell />
}
