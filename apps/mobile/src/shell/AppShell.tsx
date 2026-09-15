import { useEffect, useState, type ReactNode } from 'react'
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
      <header className="shrink-0 border-b border-border bg-surface-0 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{originLabel(app.origin)}</p>
            <p className="truncate text-2xs text-fg-subtle">{describe(app.connection)}</p>
          </div>
          <ConnectionDot state={app.connection} />
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
        <ul className="flex">
          {DESTINATIONS.map((entry) => (
            <li key={entry.id} className="flex-1">
              <button
                type="button"
                aria-current={destination === entry.id ? 'page' : undefined}
                onClick={() => setDestination(entry.id)}
                className={`flex h-14 w-full items-center justify-center text-sm ${
                  destination === entry.id
                    ? 'font-medium text-accent'
                    : 'text-fg-muted'
                }`}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}

function ConnectionDot({ state }: { state: ConnectionState }): ReactNode {
  const tone = toneOf(state)
  return (
    <span className="flex items-center gap-2">
      {/* A dot alone would be colour-only status, so the words carry it too. */}
      <span aria-hidden className={`h-2 w-2 rounded-full ${tone.className}`} />
      <span className="text-2xs text-fg-muted">{tone.label}</span>
    </span>
  )
}

function toneOf(state: ConnectionState): { label: string; className: string } {
  switch (state) {
    case 'connected':
      return { label: 'Connected', className: 'bg-success' }
    case 'connecting':
    case 'reconnecting':
      return { label: 'Reconnecting', className: 'bg-warning' }
    case 'revoked':
      return { label: 'Access revoked', className: 'bg-danger' }
    case 'unknown-device':
      return { label: 'Needs pairing', className: 'bg-warning' }
    case 'version-mismatch':
      return { label: 'Update needed', className: 'bg-danger' }
    case 'unreachable':
      return { label: 'Unreachable', className: 'bg-danger' }
    default:
      return { label: 'Not paired', className: 'bg-fg-subtle' }
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
