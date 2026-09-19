import { useState, type ReactNode } from 'react'
import { PairScreen } from './features/pair/PairScreen'
import { AppShell } from './shell/AppShell'
import { takeInvitationFromUrl, useApp } from './lib/app-state'

/**
 * Three states, never two: still deciding, not yet paired, or driving.
 *
 * A pairing link is read once, at boot, before anything renders — and the
 * fragment is cleared from the address bar immediately, so a screenshot, a
 * share or a reload cannot hand the invitation on to anyone else. The splash
 * matters because a paired phone must never see the pairing screen on its
 * way in: that reads as "you are not connected" on every launch.
 */
export function App(): ReactNode {
  const app = useApp()
  const [invitation] = useState<string | null>(() => takeInvitationFromUrl(location.href))

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
  if (app.connection === 'unpaired' || app.origin === null) {
    return <PairScreen invitationId={invitation} />
  }
  return <AppShell />
}
