import { useEffect, useState, type ReactNode } from 'react'
import { TabIcon } from './TabIcon'
import { NowScreen } from '../features/now/NowScreen'
import { ProjectsScreen } from '../features/projects/ProjectsScreen'
import { SessionScreen } from '../features/session/SessionScreen'
import { SessionsScreen } from '../features/sessions/SessionsScreen'
import { SettingsScreen } from '../features/settings/SettingsScreen'
import { useApp } from '../lib/app-state'
import { UpdateBanner, applyUpdate, registerServiceWorker } from '../lib/service-worker'
import type { ConnectionState } from '../lib/session'

/**
 * The shell ADR §13 describes: four destinations, the computer and its
 * connection state always visible above them, and a session that opens over
 * the top because it is a place you go and come back from.
 */

type Destination = 'now' | 'sessions' | 'projects' | 'settings'

const DESTINATIONS: { id: Destination; label: string }[] = [
  { id: 'now', label: 'Now' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'projects', label: 'Projects' },
  { id: 'settings', label: 'Settings' },
]

export function AppShell(): ReactNode {
  const app = useApp()
  const [destination, setDestination] = useState<Destination>('now')
  const [open, setOpen] = useState<string | null>(null)
  const [updateReady, setUpdateReady] = useState(false)
  const [updateDismissed, setUpdateDismissed] = useState(false)

  useEffect(() => {
    registerServiceWorker(() => setUpdateReady(true))
  }, [])

  if (open !== null) {
    return <SessionScreen sessionId={open} onBack={() => setOpen(null)} />
  }

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {updateReady && !updateDismissed && (
        <UpdateBanner onApply={applyUpdate} onDismiss={() => setUpdateDismissed(true)} />
      )}
      <header className="shrink-0 border-b border-border bg-surface-0 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold tracking-tight">
              {originLabel(app.origin)}
            </p>
            <p className="mt-0.5 truncate text-xs text-fg-subtle">{describe(app.connection)}</p>
          </div>
          <ConnectionPill state={app.connection} />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        {destination === 'now' && <NowScreen onOpen={setOpen} />}
        {destination === 'sessions' && <SessionsScreen onOpen={setOpen} />}
        {destination === 'projects' && <ProjectsScreen onOpen={setOpen} />}
        {destination === 'settings' && <SettingsScreen />}
      </main>

      <nav
        aria-label="Main"
        className="shrink-0 border-t border-border bg-surface-0 pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="flex gap-1 px-2 pt-1">
          {DESTINATIONS.map((entry) => {
            const active = destination === entry.id
            return (
              <li key={entry.id} className="flex-1">
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setDestination(entry.id)}
                  className={`flex min-h-14 w-full flex-col items-center justify-center gap-1 rounded-lg py-1.5 text-2xs ${
                    active ? 'bg-surface-2 font-medium text-fg' : 'text-fg-muted'
                  }`}
                >
                  <TabIcon id={entry.id} />
                  {entry.label}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}

function ConnectionPill({ state }: { state: ConnectionState }): ReactNode {
  const tone = toneOf(state)
  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-1 px-2.5 py-1.5 text-2xs font-medium ${tone.text}`}
    >
      {/* A dot alone would be colour-only status, so the words carry it too. */}
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {tone.label}
    </span>
  )
}

function toneOf(state: ConnectionState): { label: string; dot: string; text: string } {
  switch (state) {
    case 'connected':
      return { label: 'Connected', dot: 'bg-success', text: 'text-fg' }
    case 'connecting':
    case 'reconnecting':
      return { label: 'Reconnecting', dot: 'bg-warning', text: 'text-fg' }
    case 'revoked':
      return { label: 'Revoked', dot: 'bg-danger', text: 'text-danger' }
    case 'unknown-device':
      return { label: 'Needs pairing', dot: 'bg-warning', text: 'text-fg' }
    case 'version-mismatch':
      return { label: 'Update needed', dot: 'bg-danger', text: 'text-danger' }
    case 'unreachable':
      return { label: 'Unreachable', dot: 'bg-danger', text: 'text-danger' }
    default:
      return { label: 'Not paired', dot: 'bg-fg-subtle', text: 'text-fg-muted' }
  }
}

/** What the user calls the machine they are driving. */
function originLabel(origin: string | null): string {
  if (origin === null) return 'No computer'
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/** The banner's sentence, which says only what the client actually knows. */
function describe(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Agents keep running here while you are away'
    case 'connecting':
      return 'Connecting…'
    case 'reconnecting':
      return 'Lost the connection — retrying'
    case 'revoked':
      return 'This device was revoked on the desktop'
    case 'unknown-device':
      return 'The desktop no longer knows this device'
    case 'version-mismatch':
      return 'This app and the desktop speak different versions'
    case 'unreachable':
      return 'No answer from the desktop. It may be off, asleep, or offline.'
    default:
      return 'Pair with the desktop to start'
  }
}
