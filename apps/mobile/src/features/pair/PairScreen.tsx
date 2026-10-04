import { useState, type ReactNode } from 'react'
import { ArrowRight, Laptop, Network, ShieldCheck, Smartphone } from 'lucide-react'
import { useApp } from '../../lib/app-state'
import { IS_CONNECT_BUILD } from '../../lib/connect'

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
  const [link, setLink] = useState('')
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
  function useLink(): void {
    setFailure(null)
    try {
      const url = new URL(link.trim())
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Use the full HTTPS pairing link from desktop Mobile access settings.')
      if (url.origin !== location.origin)
        throw new Error(
          'This link belongs to another address. Use a pairing link for this Ari app’s computer.',
        )
      const invitation = new URLSearchParams(url.hash.slice(1)).get('pair')
      if (!invitation?.trim())
        throw new Error(
          'This address has no pairing code. Copy a fresh pairing link from your computer.',
        )
      setLink('')
      onInvitation(invitation)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Enter a fresh pairing link.')
    }
  }
  return (
    <div className="mobile-shell overflow-y-auto px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between">
        <span className="text-2xl font-semibold tracking-[-0.06em]">
          ari<span className="text-accent">.</span>
        </span>
        <span className="rounded-full border border-border px-3 py-1.5 text-[11px] text-fg-muted">
          Mobile workspace
        </span>
      </header>
      <div className="mb-8 mt-12">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-2xl border border-border bg-surface-1">
            <Laptop size={23} />
          </span>
          <span className="h-px w-8 bg-border-strong" />
          <span className="flex size-12 items-center justify-center rounded-2xl border border-border bg-surface-1">
            <Smartphone size={22} />
          </span>
        </div>
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
                ? 'This phone’s access was revoked. Scan a fresh pairing QR in desktop Settings → Mobile access, then approve this phone again. Retrying the old connection cannot restore access.'
                : 'Your computer no longer recognizes this phone. Scan a fresh pairing QR in desktop Settings → Mobile access, then approve this phone again.'
            : invitationId === null
              ? installed
                ? 'On iPhone, this Home Screen app has its own secure storage. Pair it once here, even if Safari is already connected. Future launches reconnect automatically.'
                : 'Build, review, and guide your agents from anywhere. Your computer remains the workspace.'
              : 'Give this phone a name. Confirm the matching code in Ari on your computer, then choose the projects it can access.'}
        </p>
      </div>
      {invitationId !== null ? (
        <section>
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
            {!busy && <ArrowRight size={17} />}
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
              useLink()
            }}
          >
            <label htmlFor="pairing-link" className="block text-xs text-fg-muted">
              Fresh pairing link
            </label>
            <input
              id="pairing-link"
              type="url"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://computer.tailnet.ts.net/#pair=…"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="min-h-12 w-full rounded-xl border border-border bg-surface-1 px-3 text-base"
            />
            <button type="submit" className="primary-button w-full" disabled={!link.trim()}>
              Use pairing link <ArrowRight size={15} />
            </button>
            <p className="text-xs leading-relaxed text-fg-muted">
              Create a fresh link in desktop Settings → Mobile access. Paste it here, then approve
              the matching code on your computer.
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
                  ? 'Copy the pairing link and paste it above. Opening the QR in Safari pairs Safari instead of this app.'
                  : "Scan the pairing QR with your phone's camera."}
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
                  <ArrowRight size={15} />
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
