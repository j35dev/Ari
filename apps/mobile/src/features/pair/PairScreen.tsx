import { useEffect, useState, type ReactNode } from 'react'
import { useApp } from '../../lib/app-state'
import { connectionLabel } from '../../lib/format'

/**
 * Pairing, which is the one screen the user cannot get past with a tap.
 *
 * The desktop approves this device, not the other way round: the invitation
 * only says which computer to ask, and the code below is derived from this
 * browser's own public key so the user can check that the two screens are
 * talking about the same phone.
 */
export function PairScreen({ invitationId }: { invitationId: string | null }): ReactNode {
  const app = useApp()
  const [displayName, setDisplayName] = useState(() => defaultDeviceName())
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [address, setAddress] = useState(app.origin ?? '')
  const [waiting, setWaiting] = useState(false)

  useEffect(() => {
    if (invitationId !== null && app.origin !== null) void start()
    // Attempted once per invitation: re-running would register a second key.
  }, [invitationId, app.origin])

  async function start(): Promise<void> {
    if (invitationId === null) return
    setBusy(true)
    setWaiting(false)
    setFailure(null)
    try {
      // The wait is the flow: this call returns only once the desktop has asked
      // the user and they have answered.
      setWaiting(true)
      await app.pair(invitationId, displayName)
    } catch (error) {
      setFailure(messageFor(error))
    } finally {
      setBusy(false)
      setWaiting(false)
    }
  }

  function connectTo(address: string): void {
    const trimmed = address.trim().replace(/\/+$/, '')
    if (trimmed.length === 0) return
    try {
      app.rememberOrigin(new URL(trimmed).origin)
    } catch {
      setFailure('That does not look like an address. It should start with https://')
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg px-5 pb-[env(safe-area-inset-bottom)] pt-[max(1rem,env(safe-area-inset-top))] text-fg">
      <h1 className="mt-6 text-[28px] font-bold leading-tight tracking-tight">Pair this phone</h1>
      <p className="mt-2 text-sm text-fg-muted">
        Ari keeps running on your computer. This phone becomes a remote control for it —
        and the desktop decides what it may reach.
      </p>

      {app.origin === null ? (
        <section className="mt-6">
          <label className="block text-sm" htmlFor="desktop-address">
            Desktop address
          </label>
          <input
            id="desktop-address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="https://your-desktop.tailnet.ts.net"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            className="mt-2 h-12 w-full rounded-xl border border-border bg-surface-1 px-4 text-fg placeholder:text-fg-subtle"
          />
          <button
            type="button"
            onClick={() => connectTo(address)}
            className="mt-3 h-12 w-full rounded-xl bg-accent font-medium text-fg-on-accent"
          >
            Use this desktop
          </button>
          <p className="mt-3 text-xs text-fg-subtle">
            The address is shown in Ari on the desktop under Settings → Remote access. Opening
            the pairing link from there fills this in for you.
          </p>
        </section>
      ) : (
        <section className="mt-6">
          <p className="text-sm text-fg-muted">
            Desktop: <span className="font-mono text-fg">{app.origin}</span>
          </p>

          {invitationId === null ? (
            <p className="mt-4 rounded-md border border-border bg-surface-1 p-3 text-sm">
              No pairing link was found. Open Ari on the desktop, choose{' '}
              <span className="font-medium">Settings → Remote access → Show pairing code</span>, and
              scan that QR code with this phone's camera.
            </p>
          ) : (
            <>
              <label className="mt-4 block text-sm" htmlFor="device-name">
                Name for this device
              </label>
              <input
                id="device-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={80}
                className="mt-2 h-12 w-full rounded-xl border border-border bg-surface-1 px-4 text-fg"
              />
              <button
                type="button"
                disabled={busy || displayName.trim().length === 0}
                onClick={() => void start()}
                className="mt-3 h-12 w-full rounded-xl bg-accent font-medium text-fg-on-accent disabled:opacity-50"
              >
                {busy ? 'Waiting for approval…' : 'Ask the desktop to approve'}
              </button>
              {waiting && (
                <p role="status" className="mt-3 text-sm text-fg-muted">
                  Look at Ari on your computer: it shows this device and a short code. Approve it
                  there to finish.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {failure !== null && (
        <p role="alert" className="mt-4 rounded-md border border-danger bg-danger-subtle p-3 text-sm">
          {failure}
        </p>
      )}

      <p className="mt-auto pt-6 text-xs text-fg-subtle">
        {connectionLabel(app.connection)}
        {app.origin !== null && ' — the invitation expires five minutes after it is shown.'}
      </p>
    </div>
  )
}

/** A name the user will recognise in the desktop's device list. */
function defaultDeviceName(): string {
  const platform = navigator.userAgent.includes('Android')
    ? 'Android'
    : /iPhone|iPad/.test(navigator.userAgent)
      ? 'iPhone'
      : 'Browser'
  return `${platform} phone`
}

function messageFor(error: unknown): string {
  if (error instanceof Error) {
    switch (error.message) {
      case 'this device was not approved':
        return 'The desktop declined this device.'
      case 'the invitation expired':
      case 'the desktop did not answer in time':
        return 'The invitation expired. Show a new pairing code on the desktop and scan it again.'
      case 'this invitation was already used':
        return 'That pairing code has already been used. Show a new one and try again.'
      default:
        return error.message
    }
  }
  return 'Pairing did not finish.'
}
