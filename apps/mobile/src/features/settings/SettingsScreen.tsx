import { useState, type ReactNode } from 'react'
import { ScreenHeader } from '../../components/ui'
import { useApp } from '../../lib/app-state'
import { connectionLabel, relativeTime } from '../../lib/format'

/**
 * Settings: which computer, whether the link is alive, and what this phone is
 * allowed to do (ADR §13).
 *
 * Unpairing is the one destructive action here, and it is the user's own: it
 * forgets the device key on this browser, which the desktop cannot undo for
 * them — the desktop can only revoke what it knows about.
 */
export function SettingsScreen(): ReactNode {
  const app = useApp()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="h-full overflow-y-auto px-4 pb-6 pt-4">
      <ScreenHeader title="Settings" subtitle="This phone and its desktop." />
      <section className="mb-6 mt-4">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Computer</h2>
        <div className="rounded-2xl border border-border bg-surface-1 p-4 text-sm">
          <p className="font-mono text-xs break-all">{app.origin ?? 'None'}</p>
          <p className="mt-1 text-fg-muted">{connectionLabel(app.connection)}</p>
          <p className="mt-2 text-2xs text-fg-subtle">
            The agents keep running on the computer whether or not this phone is connected.
          </p>
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">This device</h2>
        <dl className="rounded-2xl border border-border bg-surface-1 p-4 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-fg-muted">Projects shared</dt>
            <dd>{app.projects.length}</dd>
          </div>
          <div className="mt-1 flex justify-between gap-3">
            <dt className="text-fg-muted">Sessions visible</dt>
            <dd>{app.sessions.length}</dd>
          </div>
          <div className="mt-1 flex justify-between gap-3">
            <dt className="text-fg-muted">Last refresh</dt>
            <dd>{relativeTime(Date.now())}</dd>
          </div>
        </dl>
        <p className="mt-2 text-2xs text-fg-subtle">
          Revoking this device is done on the computer: Settings → Remote access → Devices.
        </p>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
          What this desktop allows
        </h2>
        <ul className="rounded-2xl border border-border bg-surface-1 p-4 text-xs text-fg-muted">
          {app.capabilities.length === 0 && <li>Nothing yet — the desktop has not been asked.</li>}
          {app.capabilities.map((capability) => (
            <li key={capability} className="font-mono">
              {capability}
            </li>
          ))}
        </ul>
      </section>

      {error !== null && (
        <p role="alert" className="mb-4 rounded-md border border-danger bg-danger-subtle p-3 text-sm">
          {error}
        </p>
      )}

      <section>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="h-12 w-full rounded-xl border border-danger text-sm font-medium text-danger"
        >
          Forget this computer
        </button>
        {confirming && (
          <div className="mt-3 rounded-md border border-danger bg-danger-subtle p-3">
            <p className="text-sm">
              This erases the key stored on this phone. You will need a new pairing code from the
              desktop to use it again.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="h-11 flex-1 rounded-md border border-border bg-surface-1 text-sm"
                onClick={() => setConfirming(false)}
              >
                Keep it
              </button>
              <button
                type="button"
                className="h-11 flex-1 rounded-md bg-danger text-sm text-fg-on-accent"
                onClick={() => {
                  void app.forget().catch((failure: unknown) => {
                    setError(failure instanceof Error ? failure.message : 'could not forget it')
                  })
                }}
              >
                Forget
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
