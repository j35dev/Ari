import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { Project } from '@ari/contracts/project'
import type { RemoteState, TailscaleState } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { Button } from '@ari/ui/button'
import { Switch } from '@ari/ui/switch'
import { rpc } from '../../lib/rpc'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'

const log = createLogger('settings:remote')

/**
 * Remote access (ADR §5, §18): the switch that runs the gateway, the pairing
 * prompt a phone's request lands in, the devices the user has approved, and
 * the Tailscale controls that make any of it reachable from a phone.
 *
 * The panel only ever shows a code for an address a phone can actually open:
 * an invitation encodes the origin it was minted for, and until Serve (or a
 * tunnel) gives that origin a public face it is loopback, which on a phone
 * means the phone itself. Saying that is better than a QR code that lies.
 */
export function RemoteSettings() {
  const [remote, setRemote] = useState<RemoteState | null>(null)
  const [tailscale, setTailscale] = useState<TailscaleState | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [qr, setQr] = useState<string | null>(null)
  const [granted, setGranted] = useState<string[]>([])
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void rpc
      .invoke('remote.status')
      .then((state) => {
        if (live) setRemote(state)
      })
      .catch((error: unknown) => log.warn('remote.status failed', { error }))
    void rpc
      .invoke('remote.tailscale.status')
      .then((state) => {
        if (live) setTailscale(state)
      })
      .catch((error: unknown) => log.warn('remote.tailscale.status failed', { error }))
    // The projects a device may be granted are the projects Ari knows about.
    void rpc
      .invoke('project.list')
      .then((list) => {
        if (live) setProjects(list)
      })
      .catch((error: unknown) => log.warn('project.list failed', { error }))
    const unsubscribe = rpc.subscribe('remote.updates', {}, (payload) => {
      setRemote(payload as RemoteState)
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  const pending = remote?.pending ?? null
  const invitation = remote?.invitation ?? null
  const clientUrl = remote?.clientUrl ?? null

  // A new device means a new grant: nothing carries over from the last one.
  useEffect(() => {
    setGranted([])
  }, [pending?.invitationId])

  const invitationUrl = clientUrl === null ? null : (invitation?.url ?? null)

  useEffect(() => {
    if (invitationUrl === null) {
      setQr(null)
      return
    }
    let live = true
    QRCode.toString(invitationUrl, {
      type: 'svg',
      margin: 1,
      width: 192,
      // A camera needs contrast the theme cannot promise: in a dark palette
      // the modules would sit black-on-black and scan as nothing.
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((svg) => {
        if (live) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
      })
      .catch((error: unknown) => {
        log.warn('could not render the pairing code', { error })
        if (live) setQr(null)
      })
    return () => {
      live = false
    }
  }, [invitationUrl])

  const adopt = (call: Promise<RemoteState>): void => {
    void call
      .then(setRemote)
      .catch((error: unknown) => log.warn('remote access call failed', { error }))
  }

  const setEnabled = (enabled: boolean): void => {
    adopt(enabled ? rpc.invoke('remote.enable', {}) : rpc.invoke('remote.disable'))
  }

  const enableServe = (): void => {
    void rpc
      .invoke('remote.tailscale.enable')
      .then((state) => {
        setRemote(state.remote)
        setTailscale(state.tailscale)
      })
      .catch((error: unknown) => log.warn('enabling Tailscale Serve failed', { error }))
  }

  const disableServe = (): void => {
    void rpc
      .invoke('remote.tailscale.disable')
      .then(setTailscale)
      .catch((error: unknown) => log.warn('stopping Tailscale Serve failed', { error }))
  }

  const approve = (): void => {
    if (pending === null) return
    adopt(
      rpc.invoke('remote.approve', {
        invitationId: pending.invitationId,
        projectIds: granted,
      }),
    )
  }

  const deny = (): void => {
    if (pending === null) return
    adopt(rpc.invoke('remote.deny', { invitationId: pending.invitationId }))
  }

  const revoke = (deviceId: string): void => {
    void rpc
      .invoke('remote.revokeDevice', { deviceId })
      .then((state) => {
        setRemote(state)
        setConfirmingRevoke(null)
      })
      .catch((error: unknown) => log.warn('revoking a device failed', { error }))
  }

  // Serve needs a listener to proxy to, so the control is only usable once
  // remote access is on and Tailscale is on a tailnet.
  const canServe =
    remote?.enabled === true &&
    tailscale !== null &&
    tailscale.installed &&
    tailscale.origin !== null

  return (
    <SettingsPage
      title="Remote access"
      description="Drive this desktop from a phone, over your own network."
    >
      <section aria-labelledby="remote-access-heading">
        <h2 id="remote-access-heading" className="sr-only">
          Remote access
        </h2>
        <SettingsRow
          label="Remote access"
          hint="Runs a small server on this computer that a paired phone can use."
        >
          <Switch
            checked={remote?.enabled ?? false}
            onCheckedChange={setEnabled}
            aria-label="Remote access"
            disabled={remote === null}
          />
        </SettingsRow>
        {remote?.error != null ? (
          <p role="alert" className="mt-3 text-xs text-danger">
            {remote.error}
          </p>
        ) : null}
        {remote?.enabled === true ? (
          <p className="mt-3 text-xs text-fg-muted">
            {clientUrl === null
              ? 'Not reachable from a phone yet. Turn on Tailscale Serve below to get an address.'
              : `A phone should open ${clientUrl}.`}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="remote-pairing-heading" className="space-y-3">
        <h2 id="remote-pairing-heading" className="text-sm font-medium">
          Pair a phone
        </h2>
        {remote?.enabled !== true ? (
          <p className="text-xs text-fg-muted">Turn remote access on to pair a phone.</p>
        ) : clientUrl === null ? (
          // The invitation would encode this machine's loopback address, which
          // on a phone is the phone; the Tailscale step comes first.
          <p className="text-xs leading-relaxed text-fg-muted">
            No address a phone can reach exists yet. Turn on Tailscale Serve below, then open an
            invitation here.
          </p>
        ) : invitation === null ? (
          <div className="flex items-center justify-between gap-6">
            <p className="text-xs text-fg-muted">
              Open an invitation, then scan it with the phone's camera.
            </p>
            <Button onClick={() => adopt(rpc.invoke('remote.invite'))} className="min-h-11">
              Show pairing code
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-start gap-4 rounded-md border border-border bg-surface-1 p-3">
            {qr === null ? (
              <p className="text-xs text-fg-muted">Preparing the pairing code...</p>
            ) : (
              <img src={qr} alt="Pairing QR code" width={192} height={192} className="rounded-sm" />
            )}
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm text-fg">Scan this with the phone's camera.</p>
              <p className="text-xs text-fg-muted">Expires {formatTime(invitation.expiresAt)}.</p>
              <code className="block truncate text-xs text-fg-subtle">{invitation.url}</code>
            </div>
            <Button
              variant="ghost"
              onClick={() => adopt(rpc.invoke('remote.cancelInvite'))}
              className="min-h-11"
            >
              Cancel
            </Button>
          </div>
        )}
      </section>

      {pending !== null ? (
        <section
          aria-labelledby="remote-pending-heading"
          className="space-y-3 rounded-md border border-accent/60 bg-surface-1 p-3"
        >
          <h2 id="remote-pending-heading" className="text-sm font-medium">
            A device wants to connect
          </h2>
          <p className="text-xs leading-relaxed text-fg-muted">
            {pending.displayName} asked to pair. The code below must match the one on the phone's
            screen — approve only when both screens show the same code.
          </p>
          <p aria-label="Confirmation code" className="font-mono text-2xl tracking-[0.3em] text-fg">
            {pending.confirmationCode}
          </p>
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-fg">Projects this device may reach</legend>
            {projects.length === 0 ? (
              <p className="text-xs text-fg-muted">No projects are registered yet.</p>
            ) : (
              projects.map((project) => (
                <label key={project.id} className="flex min-h-11 items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={granted.includes(project.id)}
                    onChange={(event) => {
                      const checked = event.target.checked
                      setGranted((current) =>
                        checked
                          ? [...current, project.id]
                          : current.filter((id) => id !== project.id),
                      )
                    }}
                    className="size-4 accent-accent"
                  />
                  {project.name}
                </label>
              ))
            )}
          </fieldset>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={approve}
              disabled={granted.length === 0}
              className="min-h-11"
            >
              Approve
            </Button>
            <Button variant="secondary" onClick={deny} className="min-h-11">
              Deny
            </Button>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="remote-devices-heading" className="space-y-3">
        <h2 id="remote-devices-heading" className="text-sm font-medium">
          Paired devices
        </h2>
        {(remote?.devices.length ?? 0) === 0 ? (
          <p className="text-xs text-fg-muted">No phones are paired yet.</p>
        ) : (
          <ul className="space-y-2">
            {remote?.devices.map((device) => (
              <li
                key={device.deviceId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-1 px-3 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm text-fg">{device.displayName}</p>
                  <p className="text-xs text-fg-muted">
                    Paired {formatTime(device.pairedAt)} —{' '}
                    {device.lastSeenAt === null
                      ? 'never connected'
                      : `last seen ${formatTime(device.lastSeenAt)}`}
                  </p>
                  <p className="text-xs text-fg-muted">
                    Projects: {grantedProjects(device.projectIds, projects)}
                  </p>
                </div>
                {confirmingRevoke === device.deviceId ? (
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      onClick={() => revoke(device.deviceId)}
                      aria-label={`Confirm revoke ${device.displayName}`}
                      className="min-h-11"
                    >
                      Confirm revoke
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmingRevoke(null)}
                      aria-label={`Keep ${device.displayName}`}
                      className="min-h-11"
                    >
                      Keep access
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="danger"
                    onClick={() => setConfirmingRevoke(device.deviceId)}
                    aria-label={`Revoke ${device.displayName}`}
                    className="min-h-11"
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="remote-tailscale-heading" className="space-y-3">
        <h2 id="remote-tailscale-heading" className="text-sm font-medium">
          Tailscale
        </h2>
        {/* The error is the more specific sentence whenever there is one; the
            summary describes the states that are not failures. */}
        <p className="text-xs leading-relaxed text-fg-muted">
          {tailscale?.error ?? tailscaleSummary(tailscale)}
        </p>
        {tailscale?.serving === true ? (
          <Button onClick={disableServe} className="min-h-11">
            Stop serving Ari
          </Button>
        ) : (
          <div className="space-y-1">
            <Button onClick={enableServe} disabled={!canServe} className="min-h-11">
              Serve Ari over Tailscale
            </Button>
            {remote?.enabled !== true ? (
              <p className="text-xs text-fg-muted">
                Turn remote access on first; Serve needs a listener to point at.
              </p>
            ) : null}
          </div>
        )}
      </section>
    </SettingsPage>
  )
}

/** Absolute rather than a countdown: no timer, and the same answer every render. */
function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** The names behind a device's grant; an unknown id is shown as itself. */
function grantedProjects(projectIds: readonly string[], projects: readonly Project[]): string {
  if (projectIds.length === 0) return 'none'
  return projectIds.map((id) => projects.find((p) => p.id === id)?.name ?? id).join(', ')
}

/** One line per status the panel can be in; status is never colour alone. */
function tailscaleSummary(state: TailscaleState | null): string {
  if (state === null) return 'Checking Tailscale...'
  if (!state.installed) return 'Tailscale is not installed on this computer.'
  if (state.origin === null) {
    return 'Tailscale is installed, but this computer is not connected to a tailnet yet.'
  }
  if (state.serving) return `Serving Ari at ${state.origin}.`
  return 'Tailscale is connected; Ari is not served to the tailnet yet.'
}
