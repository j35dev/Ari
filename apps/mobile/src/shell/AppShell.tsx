import { useEffect, useState, type ReactNode } from 'react'
import { useTheme } from '@ari/ui/theme-provider'
import { TabIcon } from './TabIcon'
import { NowScreen } from '../features/now/NowScreen'
import { NewSessionSheet, ProjectsScreen } from '../features/projects/ProjectsScreen'
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

type Destination = 'projects' | 'sessions' | 'now' | 'settings'

const DESTINATIONS: { id: Destination; label: string }[] = [
  { id: 'projects', label: 'Projects' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'now', label: 'Remote' },
  { id: 'settings', label: 'More' },
]

export function AppShell(): ReactNode {
  const app = useApp()
  const { resolvedScheme, setMode } = useTheme()
  const [destination, setDestination] = useState<Destination>('projects')
  const [open, setOpen] = useState<string | null>(null)
  const [updateReady, setUpdateReady] = useState(false)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [expandRequest, setExpandRequest] = useState<{ projectId: string; nonce: number } | null>(
    null,
  )

  const runningCount = app.sessions.filter((s) => s.status === 'running').length

  const toggleTheme = (): void => {
    setMode(resolvedScheme === 'dark' ? 'sandstone' : 'graphite')
  }

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
      <header className="shrink-0 border-b border-border bg-surface-0 px-4 pb-2.5 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between gap-3">
          {/* Brand mark matching mockup */}
          <div className="min-w-0">
            <span className="text-xl font-bold tracking-tight text-fg">
              Ari<span className="text-accent">.</span>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <ConnectionPill state={app.connection} host={originLabel(app.origin)} />

            {/* Dark / Light Mode Toggle */}
            <button
              type="button"
              onClick={toggleTheme}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-1 text-fg transition-colors hover:bg-surface-2 active:scale-95"
              aria-label={resolvedScheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={resolvedScheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {resolvedScheme === 'dark' ? (
                <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="10" cy="10" r="4" />
                  <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42" />
                </svg>
              ) : (
                <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M17.5 11.5A7.5 7.5 0 1 1 8.5 2.5a6 6 0 0 0 9 9Z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      {app.connection === 'unreachable' && (
        <button
          type="button"
          onClick={() => void app.reconnect()}
          className="flex min-h-11 w-full shrink-0 items-center justify-center gap-2 border-b border-border bg-surface-1 px-4 text-sm text-fg"
        >
          No answer from the desktop — tap to try again
        </button>
      )}

      <main className="min-h-0 flex-1 overflow-hidden">
        {destination === 'now' && <NowScreen onOpen={setOpen} />}
        {destination === 'sessions' && <SessionsScreen onOpen={setOpen} />}
        {destination === 'projects' && (
          <ProjectsScreen
            onOpen={setOpen}
            expandRequest={expandRequest}
            onNewSession={() => setSheetOpen(true)}
          />
        )}
        {destination === 'settings' && <SettingsScreen />}
      </main>

      {sheetOpen && (
        <NewSessionSheet
          onClose={() => setSheetOpen(false)}
          onPick={(projectId) => {
            setSheetOpen(false)
            setExpandRequest({ projectId, nonce: Date.now() })
            setDestination('projects')
          }}
        />
      )}

      <nav
        aria-label="Main"
        className="shrink-0 border-t border-border bg-surface-0 pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="flex gap-1 px-2 pt-1">
          {DESTINATIONS.map((entry) => {
            const active = destination === entry.id
            return (
              <li key={entry.id} className="relative flex-1">
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setDestination(entry.id)}
                  className={`flex min-h-14 w-full flex-col items-center justify-center gap-1 py-1.5 text-2xs ${
                    active ? 'font-medium text-accent' : 'text-fg-muted'
                  }`}
                >
                  <div className="relative">
                    <TabIcon id={entry.id} />
                    {entry.id === 'now' && runningCount > 0 && (
                      <span
                        aria-label={`${runningCount} running`}
                        className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent"
                      />
                    )}
                  </div>
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

function ConnectionPill({ state, host }: { state: ConnectionState; host: string }): ReactNode {
  const tone = toneOf(state)
  return (
    <div className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-surface-1 px-2.5 py-1">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      <div className="min-w-0 text-left">
        <span className={`block text-2xs font-semibold leading-none ${tone.text}`}>
          {tone.label}
        </span>
        {state === 'connected' && (
          <span className="block max-w-[130px] truncate text-[10px] text-fg-subtle leading-tight">
            {host}
          </span>
        )}
      </div>
    </div>
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


