import { useState } from 'react'
import type { RemoteConnectState } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'

interface Props {
  state: RemoteConnectState
  disabled: boolean
  enabled: boolean
  configure: (origin: string) => void
  signIn: (computerName: string) => void
  signOut: () => void
  refresh: () => void
  openBrowser: () => void
  openConnectorGuide: () => void
}

const summaries = {
  unconfigured: 'Ari Connect is invite-only',
  'signed-out': 'Sign in to connect this computer',
  'awaiting-approval': 'Finish approval in your browser',
  provisioning: 'Preparing your computer connection',
  'missing-cloudflared': 'Install the Cloudflare connector',
  connecting: 'Connecting this computer',
  ready: 'Connected through Ari Connect',
  denied: 'Computer access was not approved',
  error: 'Ari Connect needs attention',
} as const

/** Displays each managed connection stage without treating account sign-in as phone access. */
export function RemoteConnectSetup({
  state,
  disabled,
  enabled,
  configure,
  signIn,
  signOut,
  refresh,
  openBrowser,
  openConnectorGuide,
}: Props) {
  const [origin, setOrigin] = useState(state.origin ?? '')
  const [name, setName] = useState(state.computerName ?? '')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const canSignIn = ['signed-out', 'denied', 'error'].includes(state.phase)
  const connected = !['unconfigured', 'signed-out'].includes(state.phase)
  return (
    <section
      aria-labelledby="remote-connect-heading"
      className="space-y-3 border-t border-border pt-5"
    >
      <h2 id="remote-connect-heading" className="flex items-center gap-3 text-sm font-semibold">
        <span
          aria-hidden="true"
          className="flex size-6 items-center justify-center rounded-md bg-surface-2 font-mono text-xs text-fg-muted"
        >
          2
        </span>
        {summaries[state.phase]}
      </h2>
      <p className="text-sm leading-relaxed text-fg-muted">
        {state.phase === 'unconfigured'
          ? 'Ari Connect has not been configured on this computer. Your Ari administrator provides the service address. You can use Tailscale now.'
          : state.phase === 'signed-out'
            ? 'Use an invited Ari account. Sign-in opens your browser; you will approve this computer there.'
            : state.phase === 'awaiting-approval'
              ? 'Complete sign-in and approve this computer in the browser. Your account must be invited before it can register a computer.'
              : state.phase === 'provisioning'
                ? 'Your account approved this computer. Ari Connect is preparing its route; your phone cannot connect yet.'
                : state.phase === 'missing-cloudflared'
                  ? 'Install cloudflared on this computer, then check again. The connector creates an outbound connection to Cloudflare.'
                  : state.phase === 'connecting'
                    ? 'The connector is starting. Keep this computer awake while Ari checks its connection.'
                    : state.phase === 'ready'
                      ? 'Your managed connection is ready. Pair a phone below to give it explicit project access.'
                      : state.phase === 'denied'
                        ? 'The request was denied or expired. Check your invitation with the Ari administrator, then sign in again.'
                        : 'Check the error below and retry. Agents continue working on this computer.'}
      </p>
      {state.error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state.phase === 'missing-cloudflared' ? (
        <Button disabled={disabled} onClick={openConnectorGuide} className="min-h-11">
          Open connector installation guide
        </Button>
      ) : null}
      {canSignIn ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            signIn(name.trim())
          }}
          className="space-y-3"
        >
          <label
            className="block text-xs font-medium text-fg-muted"
            htmlFor="connect-computer-name"
          >
            Computer name
          </label>
          <Input
            id="connect-computer-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Home workstation"
            maxLength={64}
            required
            disabled={disabled}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={disabled || !enabled || name.trim().length === 0}
            className="min-h-11"
          >
            Sign in with Ari Connect
          </Button>
          {!enabled ? (
            <p className="text-xs text-fg-muted">Enable mobile access above before connecting.</p>
          ) : null}
        </form>
      ) : null}
      {state.phase === 'awaiting-approval' && state.browserUrl !== null ? (
        <Button disabled={disabled} onClick={openBrowser} className="min-h-11">
          Open sign-in again
        </Button>
      ) : null}
      {state.phase === 'awaiting-approval' && state.expiresAt !== null ? (
        <p className="text-xs text-fg-muted">
          Approval expires{' '}
          {new Date(state.expiresAt).toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit',
          })}
          .
        </p>
      ) : null}
      {state.phase === 'ready' && state.clientUrl !== null ? (
        <p className="break-all font-mono text-xs text-fg-muted">{state.clientUrl}</p>
      ) : null}
      {connected ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled} onClick={refresh} className="min-h-11">
            Check again
          </Button>
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => setConfirmDisconnect(true)}
            className="min-h-11"
          >
            Disconnect Ari Connect
          </Button>
        </div>
      ) : null}
      {connected && confirmDisconnect ? (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm leading-relaxed text-fg-muted">
            Disconnecting removes this computer from Ari Connect. Tailscale and local agents stay
            available.
          </p>
          <div className="flex gap-2">
            <Button variant="danger" disabled={disabled} onClick={signOut} className="min-h-11">
              Confirm disconnect
            </Button>
            <Button
              variant="ghost"
              disabled={disabled}
              onClick={() => setConfirmDisconnect(false)}
              className="min-h-11"
            >
              Keep connected
            </Button>
          </div>
        </div>
      ) : null}
      <details className="text-xs text-fg-muted" open={state.phase === 'unconfigured'}>
        <summary className="min-h-11 cursor-pointer py-3">Service configuration</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            configure(origin.trim())
          }}
          className="space-y-3 pb-3"
        >
          <label className="block font-medium" htmlFor="connect-service-origin">
            Ari Connect service address
          </label>
          <Input
            id="connect-service-origin"
            type="url"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            placeholder="https://connect.your-domain.com"
            required
            disabled={disabled || connected}
          />
          <Button
            type="submit"
            disabled={disabled || connected || origin.trim().length === 0}
            className="min-h-11"
          >
            Save service address
          </Button>
          <p className="leading-relaxed">
            Use the HTTPS address supplied by your Ari administrator. No hosted service is
            configured automatically.
          </p>
        </form>
      </details>
    </section>
  )
}
