import { useState, type ReactNode } from 'react'
import { Network, ShieldCheck } from 'lucide-react'
import { useApp } from '../../lib/app-state'
import { IS_CONNECT_BUILD } from '../../lib/connect'
import { RemoteError } from '../../lib/gateway-client'
import { readPairingEntry } from '../../lib/pairing-entry'

/** Pairing is a deliberate desktop approval with the same confirmation code on both screens. */
export function PairScreen({
  invitationId,
  onInvitation,
}: {
  invitationId: string | null
  onInvitation: (invitationId: string) => void
}): ReactNode {
  const app = useApp()
  const installed =
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  const iosBrowser = /iPhone|iPad/.test(navigator.userAgent) && !installed
  const revoked = app.connection === 'revoked'
  const missingDevice = app.connection === 'unknown-device'
  const recovering = revoked || missingDevice
  const [name, setName] = useState(
    /iPhone|iPad/.test(navigator.userAgent)
      ? installed
        ? 'My iPhone app'
        : 'My iPhone'
      : navigator.userAgent.includes('Android')
        ? 'My Android'
        : 'My browser',
  )
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [entry, setEntry] = useState('')
  const [resolving, setResolving] = useState(false)
  async function pair(): Promise<void> {
    if (invitationId === null || busy) return
    setBusy(true)
    setFailure(null)
    try {
      await app.pair(invitationId, name.trim())
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : 'Pairing did not finish. Show a fresh code on your computer and try again.',
      )
    } finally {
      setBusy(false)
    }
  }
  function openAddress(): void {
    try {
      const url = new URL(address.trim())
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Use the HTTPS address shown in desktop Mobile access settings.')
      // Each private gateway serves its own PWA; navigation avoids a cross-origin credential handoff.
      location.assign(url.href)
    } catch (error) {
      setFailure(
        error instanceof Error ? error.message : 'Enter the HTTPS address of your computer.',
      )
    }
  }
  async function useEntry(): Promise<void> {
    if (resolving) return
    setFailure(null)
    const read = readPairingEntry(entry, location.origin)
    if (read.kind === 'error') {
      setFailure(read.message)
      return
    }
    if (read.kind === 'invitation') {
      setEntry('')
      onInvitation(read.invitationId)
      return
    }
    if (app.session === null) {
      setFailure('Choose a computer first.')
      return
    }
    setResolving(true)
    try {
      onInvitation(await app.session.resolvePairingCode(read.code))
    } catch (error) {
      setFailure(
        error instanceof RemoteError && error.code === 'not_found'
          ? 'That code is not right, or it has expired. Check the code under the QR on your computer, or show a new one.'
          : error instanceof Error
            ? error.message
            : 'Could not check that code. Try again.',
      )
    } finally {
      setResolving(false)
    }
  }
  return (
    <div className="mobile-shell overflow-y-auto px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header>
        <span className="text-2xl font-semibold tracking-[-0.06em]">
          ari<span className="text-accent">.</span>
        </span>
      </header>
      <div className="mb-8 mt-14">
        <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.055em]">
          {recovering
            ? revoked
              ? 'Pair this phone again.'
              : 'Reconnect this phone.'
            : invitationId === null
              ? installed
                ? 'Connect this app.'
                : 'Ari, in your pocket.'
              : 'Make this phone yours.'}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          {recovering
            ? invitationId !== null
              ? 'A fresh pairing link is ready. Confirm the matching code in Ari on your computer, then choose the projects this phone can access again.'
              : revoked
                ? 'This phone’s access was revoked. Show a pairing code in desktop Settings → Mobile access, enter the new pairing code below, then approve this phone again. Retrying the old connection cannot restore access.'
                : 'Your computer no longer recognizes this phone. Show a pairing code in desktop Settings → Mobile access, enter the new pairing code below, then approve this phone again.'
            : invitationId === null
              ? installed
                ? 'On iPhone, this Home Screen app has its own secure storage. Pair it once here, even if Safari is already connected. Future launches reconnect automatically.'
                : 'Build, review, and guide your agents from anywhere. Your computer remains the workspace.'
              : 'Give this phone a name. Confirm the matching code in Ari on your computer, then choose the projects it can access.'}
        </p>
      </div>
      {invitationId !== null ? (
        <section>
          {iosBrowser && (
            <p className="mb-5 rounded-xl border border-border bg-surface-1 p-3 text-xs leading-relaxed text-fg-muted">
              Pairing here pairs Safari only. For the Home Screen app, choose Share → Add to Home
              Screen first, open Ari from there, and type the code shown under the QR.
            </p>
          )}
          <label className="block text-xs text-fg-muted" htmlFor="device-name">
            Device name
          </label>
          <input
            id="device-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            disabled={busy}
            className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface-1 px-4"
          />
          <button
            type="button"
            className="primary-button mt-4 w-full"
            disabled={busy || !name.trim() || app.session === null}
            onClick={() => void pair()}
          >
            {busy ? 'Waiting for your computer…' : 'Pair this phone'}
          </button>
          {busy && (
            <div
              role="status"
              className="mt-5 rounded-2xl border border-border bg-surface-1 p-5 text-center"
            >
              <p className="text-xs text-fg-muted">Match this code on your computer</p>
              <p className="my-3 font-mono text-[28px] font-medium tracking-[0.18em]">
                {app.pairingCode ?? '••••••'}
              </p>
              <p className="text-xs leading-relaxed text-fg-subtle">
                Approve only if both screens show the same code. Choose projects explicitly before
                granting access.
              </p>
            </div>
          )}
        </section>
      ) : (
        <>
          <form
            className="mb-6 space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void useEntry()
            }}
          >
            <label htmlFor="pairing-code" className="block text-xs text-fg-muted">
              Pairing code
            </label>
            <input
              id="pairing-code"
              value={entry}
              onChange={(event) => setEntry(event.target.value)}
              placeholder="XXXX-XXXX"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              disabled={resolving}
              className="min-h-14 w-full rounded-2xl border border-border bg-surface-1 px-4 text-center font-mono text-xl uppercase tracking-[0.14em] placeholder:text-fg-subtle"
            />
            <button
              type="submit"
              className="primary-button w-full"
              disabled={!entry.trim() || resolving}
            >
              {resolving ? 'Checking…' : 'Continue'}
            </button>
            <p className="text-xs leading-relaxed text-fg-muted">
              The code is under the QR in desktop Settings → Mobile access. A pasted pairing link
              works here too.
            </p>
          </form>
          <section className="rounded-2xl border border-border bg-surface-1 p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Network size={18} />
              {installed
                ? 'Keep setup in this app'
                : IS_CONNECT_BUILD
                  ? 'Approve this phone on your desktop'
                  : 'Use your own Tailscale'}
            </div>
            <ol className="space-y-3 text-sm leading-relaxed text-fg-muted">
              <li>
                <span className="mr-2 text-fg-subtle">1.</span>Open Settings → Mobile access in Ari.
              </li>
              <li>
                <span className="mr-2 text-fg-subtle">2.</span>
                {IS_CONNECT_BUILD
                  ? 'Choose Ari Connect and create a pairing code.'
                  : 'Connect your phone and computer to your Tailscale network.'}
              </li>
              <li>
                <span className="mr-2 text-fg-subtle">3.</span>
                {installed
                  ? 'Type the code under the QR above. Scanning the QR would pair Safari instead of this app.'
                  : "Scan the pairing QR with your phone's camera, or type the code under it above."}
              </li>
            </ol>
          </section>
          {!IS_CONNECT_BUILD && !installed && (
            <details className="mt-5">
              <summary className="flex min-h-11 cursor-pointer items-center text-xs text-fg-muted">
                Already have your computer's address?
              </summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  openAddress()
                }}
                className="mt-2 space-y-3"
              >
                <input
                  type="url"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="https://computer.tailnet.ts.net"
                  aria-label="Desktop address"
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="min-h-12 w-full rounded-xl border border-border bg-surface-1 px-3"
                />
                <button type="submit" className="secondary-button w-full">
                  Open computer
                </button>
              </form>
            </details>
          )}
        </>
      )}
      {(failure ?? app.error) !== null && (
        <p role="alert" className="error-banner">
          {failure ?? app.error}
        </p>
      )}
      {IS_CONNECT_BUILD && (
        <button
          type="button"
          className="mt-4 min-h-11 text-xs text-fg-muted"
          onClick={app.changeComputer}
        >
          Choose another computer
        </button>
      )}
      <div className="mt-auto flex gap-2 border-t border-border pt-5 text-[11px] leading-relaxed text-fg-subtle">
        <ShieldCheck size={16} className="shrink-0" />
        <p>
          {IS_CONNECT_BUILD
            ? 'Your account and this phone’s approved device key are both required.'
            : 'A private connection. No Ari account required. Your device key stays on this phone.'}
        </p>
      </div>
    </div>
  )
}
