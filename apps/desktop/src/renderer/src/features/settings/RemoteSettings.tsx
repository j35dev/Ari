import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Cable, Check, Cloud, Monitor, Smartphone } from 'lucide-react'
import type { RemoteState } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { Button } from '@ari/ui/button'
import { Switch } from '@ari/ui/switch'
import { rpc } from '../../lib/rpc'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import { SETTINGS_CARD_CLASS, SettingsSection } from './SettingsSection'
import { RemotePairingApproval } from './RemotePairingApproval'
import { DeviceAccessPicker } from './DeviceAccessPicker'
import { RemoteConnectSetup } from './RemoteConnectSetup'
import { RemoteTailscaleSetup } from './RemoteTailscaleSetup'
import { useRemoteAccess } from './use-remote-access'

const log = createLogger('settings:remote')

/** Guided connection setup and explicit device grants for the mobile workbench. */
export function RemoteSettings() {
  const {
    remote,
    tailscale,
    connect,
    error,
    busy,
    run,
    refresh,
    setRemote,
    setTailscale,
    setConnect,
  } = useRemoteAccess()
  const [method, setMethod] = useState<'tailscale' | 'connect'>('tailscale')
  const [qr, setQr] = useState<string | null>(null)
  const [qrError, setQrError] = useState(false)
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null)
  const [editing, setEditing] = useState<{
    deviceId: string
    allowTerminal: boolean
  } | null>(null)
  const [now, setNow] = useState(Date.now)
  const initialMethod = useRef(false)
  const disabled = busy !== null
  const pending = remote?.pending ?? null
  const invitation = remote?.invitation ?? null
  const clientUrl =
    method === 'connect'
      ? connect?.phase === 'ready'
        ? connect.clientUrl
        : null
      : matchesConnection(remote?.clientUrl ?? null, tailscale?.origin ?? null)
        ? (remote?.clientUrl ?? null)
        : tailscale?.serving === true
          ? tailscale.origin
          : null
  const reachable = remote?.enabled === true && clientUrl !== null
  const expired = invitation !== null && invitation.expiresAt <= now
  const invitationMatches = matchesConnection(invitation?.url ?? null, clientUrl)
  const invitationUrl =
    reachable && !expired && invitationMatches ? (invitation?.url ?? null) : null
  const managedPairing = method === 'connect'

  useEffect(() => {
    if (connect === null || initialMethod.current) return
    initialMethod.current = true
    if (!['unconfigured', 'signed-out'].includes(connect.phase)) setMethod('connect')
  }, [connect])

  useEffect(() => {
    const current = Date.now()
    const expiries = [invitation?.expiresAt, pending?.expiresAt].filter(
      (at): at is number => at !== undefined,
    )
    if (expiries.some((at) => at > now && at <= current)) {
      setNow(current)
      return
    }
    const expiry = Math.min(...expiries.filter((at) => at > current))
    if (!Number.isFinite(expiry)) return
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Math.max(0, expiry - Date.now()) + 1),
    )
    return () => clearTimeout(timer)
  }, [invitation?.expiresAt, pending?.expiresAt, now])

  useEffect(() => {
    setQr(null)
    setQrError(false)
    if (invitationUrl === null) return
    let live = true
    void QRCode.toString(invitationUrl, { type: 'svg', margin: 2, width: 192 })
      .then((svg) => {
        if (live) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
      })
      .catch((cause: unknown) => {
        log.warn('could not render pairing code', { error: cause })
        if (live) setQrError(true)
      })
    return () => {
      live = false
    }
  }, [invitationUrl])

  const mutate = (label: string, operation: () => Promise<RemoteState>): void => {
    run(label, async () => setRemote(await operation()))
  }
  const saveGrants = (deviceId: string, allowTerminal: boolean): void => {
    run('Save device access', async () => {
      setRemote(await rpc.invoke('remote.updateDeviceGrants', { deviceId, allowTerminal }))
      setEditing(null)
    })
  }
  const toggleAccess = (enabled: boolean): void => {
    run(enabled ? 'Enable mobile access' : 'Disable mobile access', async () => {
      setRemote(await (enabled ? rpc.invoke('remote.enable', {}) : rpc.invoke('remote.disable')))
      const [tailscaleState, connectState] = await Promise.all([
        rpc.invoke('remote.tailscale.status'),
        rpc.invoke('remote.connect.status'),
      ])
      setTailscale(tailscaleState)
      setConnect(connectState)
      setRemote(await rpc.invoke('remote.status'))
    })
  }
  const status =
    remote === null
      ? 'Checking connection'
      : !remote.enabled
        ? 'Mobile access is off'
        : !reachable
          ? 'Finish connection setup'
          : 'Ready to pair'

  return (
    <SettingsPage
      id="settings-remote"
      title="Mobile access"
      description="Use this computer from your phone or another computer."
    >
      <section
        aria-label="Connection status"
        className="flex items-center gap-4 rounded-xl border border-border bg-surface-1/70 p-4"
      >
        <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
          <Monitor size={21} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{status}</p>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            Agents and projects run here. Each phone or computer needs your approval to connect.
          </p>
        </div>
        {reachable ? <Check size={19} className="shrink-0 text-accent" aria-hidden="true" /> : null}
      </section>

      {error !== null || remote?.error != null ? (
        <div className="rounded-lg border border-danger/30 p-4">
          <p role="alert" className="text-sm text-danger">
            {error ?? remote?.error}
          </p>
          <Button variant="ghost" onClick={refresh} disabled={disabled} className="mt-2 min-h-11">
            Retry checks
          </Button>
        </div>
      ) : null}

      <SettingsSection title="Connection method" headingId="remote-method-heading" bare>
        <div role="group" aria-label="Connection method" className="grid gap-3 sm:grid-cols-2">
          {(
            [
              {
                id: 'tailscale',
                title: 'Your Tailscale',
                hint: 'Use your own private network.',
                icon: Cable,
              },
              {
                id: 'connect',
                title: 'Ari Connect',
                hint: 'Managed access. Invitation required.',
                icon: Cloud,
              },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={method === option.id}
              onClick={() => setMethod(option.id)}
              disabled={disabled}
              className={`flex items-start gap-3 rounded-xl border bg-surface-1/70 p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-60 ${method === option.id ? 'border-accent/70 ring-1 ring-accent/40' : 'border-border hover:border-border-strong hover:bg-surface-2/60'}`}
            >
              <option.icon
                size={19}
                aria-hidden="true"
                className={method === option.id ? 'mt-0.5 text-accent' : 'mt-0.5 text-fg-muted'}
              />
              <span>
                <span className="block text-sm font-medium">{option.title}</span>
                <span className="mt-1 block text-xs leading-relaxed text-fg-muted">
                  {option.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      </SettingsSection>

      <section aria-label="Mobile connection setup" className={SETTINGS_CARD_CLASS}>
        <section aria-labelledby="remote-access-heading" className="pt-4">
          <div className="px-4">
            <Step
              number="1"
              title="Enable mobile access"
              id="remote-access-heading"
              done={remote?.enabled === true}
            />
          </div>
          <SettingsRow
            label="Remote access"
            hint="Paired devices can connect while this computer is awake. Turning access off disconnects them."
          >
            <Switch
              checked={remote?.enabled ?? false}
              onCheckedChange={toggleAccess}
              aria-label="Remote access"
              disabled={remote === null || disabled}
            />
          </SettingsRow>
        </section>

        {method === 'connect' ? (
          connect === null ? (
            <p role="status" className="p-4 text-sm text-fg-muted">
              Checking Ari Connect…
            </p>
          ) : (
            <RemoteConnectSetup
              key={connect.origin ?? 'unconfigured'}
              state={connect}
              disabled={disabled}
              enabled={remote?.enabled === true}
              configure={(origin) =>
                run('Configure Ari Connect', async () =>
                  setConnect(await rpc.invoke('remote.connect.configure', { origin })),
                )
              }
              signIn={(computerName) =>
                run('Sign in with Ari Connect', async () =>
                  setConnect(await rpc.invoke('remote.connect.signIn', { computerName })),
                )
              }
              signOut={() =>
                run('Disconnect Ari Connect', async () => {
                  setConnect(await rpc.invoke('remote.connect.signOut'))
                  setRemote(await rpc.invoke('remote.status'))
                })
              }
              refresh={refresh}
              openConnectorGuide={() =>
                run('Open connector installation guide', async () => {
                  const result = await rpc.invoke('shell.openUrl', {
                    url: 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/',
                  })
                  if (!result.opened)
                    throw new Error('The browser could not open. Check your default browser.')
                })
              }
              openBrowser={() =>
                run('Open Connect sign-in', async () => {
                  if (connect.browserUrl !== null) {
                    const result = await rpc.invoke('shell.openUrl', { url: connect.browserUrl })
                    if (!result.opened)
                      throw new Error('The browser could not open. Check your default browser.')
                  }
                })
              }
            />
          )
        ) : (
          <section aria-labelledby="remote-tailscale-heading" className="space-y-3 p-4">
            <Step
              number="2"
              title="Connect your private network"
              id="remote-tailscale-heading"
              done={tailscale?.serving === true}
            />
            <RemoteTailscaleSetup
              state={tailscale}
              enabled={remote?.enabled === true}
              disabled={disabled}
              enable={(options) =>
                run('Start Tailscale Serve', async () => {
                  const state = await rpc.invoke('remote.tailscale.enable', options)
                  setRemote(state.remote)
                  setTailscale(state.tailscale)
                })
              }
              disable={() =>
                run('Stop Tailscale Serve', async () => {
                  setTailscale(await rpc.invoke('remote.tailscale.disable'))
                  setRemote(await rpc.invoke('remote.status'))
                })
              }
              refresh={refresh}
            />
          </section>
        )}

        <section aria-labelledby="remote-pairing-heading" className="space-y-3 p-4">
          <Step
            number="3"
            title="Pair a phone or computer"
            id="remote-pairing-heading"
            done={reachable && (remote?.devices.length ?? 0) > 0}
          />
          {remote?.enabled !== true ? (
            <p className="text-sm text-fg-muted">Turn remote access on to pair a device.</p>
          ) : !reachable ? (
            <p className="text-sm leading-relaxed text-fg-muted">
              No address a device can reach exists yet. Complete the connection step above, then
              create an invitation.
            </p>
          ) : invitation === null || expired || !invitationMatches ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-fg-muted">
                {expired
                  ? 'The invitation expired. Create a new code to pair.'
                  : 'Scan the code on your phone, or open the link on another computer.'}
              </p>
              <Button
                variant="primary"
                disabled={disabled}
                onClick={() =>
                  mutate('Create pairing invitation', () => rpc.invoke('remote.invite', { method }))
                }
                className="min-h-11"
              >
                Show pairing code
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-5 rounded-lg bg-surface-2/50 p-4">
              {qr === null ? (
                <p role={qrError ? 'alert' : 'status'} className="text-sm text-fg-muted">
                  {qrError
                    ? 'Could not render the code. Open the invitation address on your phone instead.'
                    : 'Preparing the pairing code...'}
                </p>
              ) : (
                <img
                  src={qr}
                  alt="Pairing QR code"
                  width={192}
                  height={192}
                  className="rounded-md"
                />
              )}
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-sm font-medium">Scan with your phone&apos;s camera</p>
                <p className="text-xs leading-relaxed text-fg-muted">
                  {managedPairing
                    ? 'This invitation uses Ari Connect.'
                    : 'Keep Tailscale connected.'}{' '}
                  Approve access here after the phone shows a matching code.
                </p>
                {invitation.code === null ? (
                  <p role="status" className="text-xs leading-relaxed text-warning">
                    Too many wrong codes were entered. The QR still works; cancel and show a new
                    pairing code to type one again.
                  </p>
                ) : invitation.code !== undefined ? (
                  <div>
                    <p className="font-mono text-xl font-medium tracking-[0.14em]">
                      {invitation.code.slice(0, 4)}-{invitation.code.slice(4)}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                      On an installed app, enter this code instead of scanning.
                    </p>
                  </div>
                ) : null}
                <p className="text-xs text-fg-muted">Expires {formatTime(invitation.expiresAt)}.</p>
                <details className="text-xs text-fg-muted">
                  <summary className="cursor-pointer py-2">Invitation address</summary>
                  <code className="block break-all font-mono text-xs">{invitation.url}</code>
                </details>
                <Button
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    mutate('Cancel invitation', () => rpc.invoke('remote.cancelInvite'))
                  }
                  className="min-h-11"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </section>
      </section>

      {pending !== null ? (
        <RemotePairingApproval
          key={`${pending.invitationId}:${pending.confirmationCode}`}
          pending={pending}
          disabled={disabled}
          expired={pending.expiresAt <= now}
          approve={(allowTerminal) =>
            mutate('Approve device', () =>
              rpc.invoke('remote.approve', {
                invitationId: pending.invitationId,
                confirmationCode: pending.confirmationCode,
                allowTerminal,
              }),
            )
          }
          deny={() =>
            mutate('Deny device', () =>
              rpc.invoke('remote.deny', { invitationId: pending.invitationId }),
            )
          }
        />
      ) : null}

      <SettingsSection
        title="Paired devices"
        headingId="remote-devices-heading"
        action={
          <span className="text-xs tabular-nums text-fg-subtle">{remote?.devices.length ?? 0}</span>
        }
        bare
      >
        {(remote?.devices.length ?? 0) === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-1/70 px-4 py-4">
            <Smartphone size={18} className="text-fg-subtle" aria-hidden="true" />
            <div className="space-y-1">
              <p className="text-sm font-medium">No paired devices</p>
              <p className="text-xs text-fg-muted">
                Pair a phone or computer to reach all your projects.
              </p>
            </div>
          </div>
        ) : (
          <ul className={SETTINGS_CARD_CLASS}>
            {remote?.devices.map((device) => (
              <li
                key={device.deviceId}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5"
              >
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{device.displayName}</p>
                  <p className="text-xs text-fg-muted">
                    {device.lastSeenAt === null
                      ? 'Never connected'
                      : `Last seen ${formatTime(device.lastSeenAt)}`}
                  </p>
                  <p className="text-xs text-fg-muted">All projects, including future projects</p>
                  <p className="text-xs text-fg-muted">
                    Terminal: {device.allowTerminal === true ? 'enabled' : 'not granted'}
                  </p>
                </div>
                {editing?.deviceId === device.deviceId ? (
                  <div className="w-full space-y-3 border-t border-border pt-3">
                    <p className="text-sm font-medium">Access for {device.displayName}</p>
                    <DeviceAccessPicker
                      allowTerminal={editing.allowTerminal}
                      disabled={disabled}
                      onChange={(allowTerminal) =>
                        setEditing({ deviceId: device.deviceId, allowTerminal })
                      }
                    />
                    <p className="text-xs leading-relaxed text-fg-muted">
                      Changes apply to open connections. Turning terminal access off closes its
                      shells.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="primary"
                        disabled={disabled}
                        onClick={() => saveGrants(device.deviceId, editing.allowTerminal)}
                        aria-label={`Save access for ${device.displayName}`}
                        className="min-h-11"
                      >
                        Save access
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => setEditing(null)}
                        aria-label={`Cancel access for ${device.displayName}`}
                        className="min-h-11"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : confirmingRevoke === device.deviceId ? (
                  <div className="space-y-2">
                    <p className="text-xs text-fg-muted">
                      This device will disconnect and need to pair again.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="danger"
                        disabled={disabled}
                        onClick={() =>
                          run('Revoke device', async () => {
                            setRemote(
                              await rpc.invoke('remote.revokeDevice', {
                                deviceId: device.deviceId,
                              }),
                            )
                            setConfirmingRevoke(null)
                          })
                        }
                        aria-label={`Confirm revoke ${device.displayName}`}
                        className="min-h-11"
                      >
                        Confirm revoke
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => setConfirmingRevoke(null)}
                        aria-label={`Keep ${device.displayName}`}
                        className="min-h-11"
                      >
                        Keep access
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => {
                        setConfirmingRevoke(null)
                        setEditing({
                          deviceId: device.deviceId,
                          allowTerminal: device.allowTerminal === true,
                        })
                      }}
                      aria-label={`Edit access for ${device.displayName}`}
                      className="min-h-11"
                    >
                      Edit access
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => setConfirmingRevoke(device.deviceId)}
                      aria-label={`Revoke ${device.displayName}`}
                      className="min-h-11 text-danger"
                    >
                      Revoke
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
      <details className="rounded-xl border border-border bg-surface-1/70 px-4 text-xs text-fg-muted">
        <summary className="min-h-11 cursor-pointer rounded-xl py-3 text-sm font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring">
          Connection diagnostics
        </summary>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 pb-4">
          <dt>Gateway</dt>
          <dd className="break-all font-mono">{remote?.origin ?? 'Not running'}</dd>
          <dt>Phone address</dt>
          <dd className="break-all font-mono">{clientUrl ?? 'Not available'}</dd>
          <dt>Tailscale host</dt>
          <dd className="break-all font-mono">{tailscale?.dnsName ?? 'Not detected'}</dd>
        </dl>
        <p className="pb-4 leading-relaxed">
          Each phone or computer needs its own approved pairing. This computer must stay awake for
          mobile access.
        </p>
      </details>
      {busy !== null ? (
        <p role="status" className="text-xs text-fg-muted">
          {busy}…
        </p>
      ) : null}
    </SettingsPage>
  )
}

function Step({
  number,
  title,
  id,
  done,
}: {
  number: string
  title: string
  id: string
  done: boolean
}) {
  return (
    <h2 id={id} className="flex items-center gap-3 text-sm font-semibold">
      <span
        aria-hidden="true"
        className={`flex size-6 items-center justify-center rounded-md text-xs font-medium tabular-nums ${done ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-fg-muted'}`}
      >
        {done ? <Check size={14} aria-hidden="true" /> : number}
      </span>
      {title}
    </h2>
  )
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function matchesConnection(invitation: string | null, clientUrl: string | null): boolean {
  if (invitation === null || clientUrl === null) return false
  try {
    const invite = new URL(invitation)
    const client = new URL(clientUrl)
    return (
      client.protocol === 'https:' &&
      invite.origin === client.origin &&
      invite.search === client.search
    )
  } catch {
    return false
  }
}
