import { useState, type ReactNode } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Laptop,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react'
import { BottomSheet } from '../../components/ui'
import { ThemePicker } from '../../components/ThemePicker'
import { useApp } from '../../lib/app-state'
import { connectionLabel, relativeTime } from '../../lib/format'
import { connectRequest, IS_CONNECT_BUILD, type ConnectAccount } from '../../lib/connect'
import { OwnerAccess } from '../connect/OwnerAccess'

/** Connection, appearance, and access are presented in everyday language. */
export function SettingsScreen({ onBack }: { onBack: () => void }): ReactNode {
  const app = useApp()
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const installed = window.matchMedia('(display-mode: standalone)').matches
  async function forget(): Promise<void> {
    setBusy(true)
    try {
      await app.forget()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not forget this computer.')
    } finally {
      setBusy(false)
    }
  }
  async function logout(): Promise<void> {
    setBusy(true)
    try {
      const account = await connectRequest<ConnectAccount>('/me')
      await connectRequest('/auth/logout', { body: {}, csrfToken: account.csrfToken })
      app.changeComputer()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not sign out.')
    } finally {
      setBusy(false)
    }
  }
  const features = [
    { op: 'session.prompt', label: 'Start and guide tasks' },
    { op: 'approval.respond', label: 'Review approvals and questions' },
    { op: 'changes.diff', label: 'Review code changes' },
    { op: 'files.read', label: 'Browse workspace files' },
    { op: 'terminal.create', label: 'Use an approved terminal' },
  ].filter((item) => app.session?.supports(item.op))
  return (
    <div className="h-full overflow-y-auto px-5 pb-8 pt-[max(0.5rem,env(safe-area-inset-top))]">
      <header className="-ml-3 flex items-center gap-1">
        <button type="button" className="icon-button" aria-label="Back" onClick={onBack}>
          <ChevronLeft size={22} />
        </button>
        <h1 className="text-[17px] font-semibold tracking-tight">Settings</h1>
      </header>
      <h2 className="section-label mt-6">Connected computer</h2>
      <section className="rounded-2xl border border-border bg-surface-1 p-4">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2">
            <Laptop size={21} className="text-fg-muted" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-medium">
              {app.origin === null ? 'No computer' : new URL(app.origin).hostname}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-muted">
              <span
                className={`size-1.5 rounded-full ${app.connection === 'connected' ? 'bg-success' : 'bg-warning'}`}
              />
              {connectionLabel(app.connection)}
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-xs text-fg-subtle">
          <span>
            {IS_CONNECT_BUILD
              ? 'Ari Connect · Approved account'
              : 'Private network · No Ari account'}
          </span>
          <button
            type="button"
            className="flex min-h-11 items-center gap-1.5 text-fg-muted"
            disabled={app.refreshing || busy}
            onClick={() => {
              void app
                .reconnect()
                .catch((error: unknown) =>
                  setFailure(error instanceof Error ? error.message : 'Could not reconnect.'),
                )
            }}
          >
            <RefreshCw size={13} />
            Reconnect
          </button>
        </div>
        <p className="text-[11px] text-fg-subtle">
          {app.lastSyncedAt === null
            ? 'Waiting for the first sync'
            : `Last synced ${relativeTime(app.lastSyncedAt)}`}
        </p>
      </section>
      {IS_CONNECT_BUILD && (
        <button
          type="button"
          className="mt-2 flex min-h-12 w-full items-center justify-between text-sm"
          onClick={app.changeComputer}
        >
          Switch computer
          <ChevronRight size={16} className="text-fg-subtle" />
        </button>
      )}
      <h2 className="section-label mt-6">Appearance</h2>
      <ThemePicker />
      <h2 className="section-label mt-6">This phone's access</h2>
      <section className="rounded-2xl border border-border p-4">
        <div className="flex items-start gap-2.5">
          <ShieldCheck size={19} className="shrink-0 text-fg-muted" />
          <div>
            <p className="text-sm font-medium">{app.projects.length} shared projects</p>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              Project access and terminal permission are approved on your computer. Revoke this
              phone there at any time.
            </p>
          </div>
        </div>
        <ul className="mt-3 space-y-2 border-t border-border pt-3 text-xs text-fg-muted">
          {features.map((item) => (
            <li key={item.op}>{item.label}</li>
          ))}
        </ul>
      </section>
      {!installed && (
        <>
          <h2 className="section-label mt-6">Keep Ari close</h2>
          <section className="flex items-start gap-3 rounded-2xl border border-border p-4">
            <Smartphone size={19} className="shrink-0 text-fg-muted" />
            <div>
              <p className="text-sm font-medium">Add Ari to your home screen</p>
              <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                {/iPhone|iPad/.test(navigator.userAgent)
                  ? 'In Safari, open Share → Add to Home Screen.'
                  : 'Open your browser menu and choose Install app or Add to Home Screen.'}{' '}
                Ari opens as a full-screen app with no app store required.
              </p>
            </div>
          </section>
        </>
      )}
      {IS_CONNECT_BUILD && <OwnerAccess />}
      {failure !== null && (
        <p role="alert" className="error-banner">
          {failure}
        </p>
      )}
      <details className="mt-6">
        <summary className="min-h-11 cursor-pointer py-3 text-xs text-fg-subtle">
          Connection diagnostics
        </summary>
        <dl className="space-y-2 break-all rounded-xl bg-surface-1 p-3 text-[11px] text-fg-muted">
          <dt>Gateway</dt>
          <dd>{app.origin}</dd>
          <dt>Device ID</dt>
          <dd>{app.session?.deviceId ?? 'Not paired'}</dd>
          <dt>Available operations</dt>
          <dd className="font-mono">{app.capabilities.join(', ')}</dd>
        </dl>
      </details>
      <button
        type="button"
        className="mt-4 min-h-12 w-full rounded-xl border border-border text-sm text-danger"
        onClick={() => setConfirming(true)}
      >
        Forget this computer
      </button>
      {IS_CONNECT_BUILD && (
        <button
          type="button"
          className="mt-2 flex min-h-12 w-full items-center justify-center gap-2 text-sm text-fg-muted"
          disabled={busy}
          onClick={() => void logout()}
        >
          <LogOut size={15} />
          Sign out of Ari Connect
        </button>
      )}
      {confirming && (
        <BottomSheet title="Forget this computer?" onClose={() => setConfirming(false)}>
          <p className="py-3 text-sm leading-relaxed text-fg-muted">
            This removes this computer's device key from your phone. You'll need a fresh pairing
            code to connect again. Other computers keep their own keys.
          </p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              className="secondary-button flex-1"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Keep it
            </button>
            <button
              type="button"
              className="primary-button flex-1 bg-danger"
              onClick={() => void forget()}
              disabled={busy}
            >
              {busy ? 'Forgetting…' : 'Forget'}
            </button>
          </div>
        </BottomSheet>
      )}
    </div>
  )
}
