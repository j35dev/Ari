import { useState, type ReactNode } from 'react'
import { PairScreen } from './features/pair/PairScreen'
import { AppShell } from './shell/AppShell'
import { takeInvitationFromUrl, useApp } from './lib/app-state'

/**
 * The two states this app can be in: not yet paired, or driving a desktop.
 *
 * A pairing link is read once, at boot, before anything renders — and the
 * fragment is cleared from the address bar immediately, so a screenshot, a
 * share or a reload cannot hand the invitation on to anyone else.
 */
export function App(): ReactNode {
  const app = useApp()
  const [invitation] = useState<string | null>(() => takeInvitationFromUrl(location.href))

  if (app.connection === 'unpaired' || app.origin === null) {
    return <PairScreen invitationId={invitation} />
  }
  return <AppShell />
}
