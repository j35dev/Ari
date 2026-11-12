import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Cable, Check, Cloud, Monitor, Smartphone } from 'lucide-react'
import type { Project } from '@ari/contracts/project'
import type { RemoteState, TailscaleState } from '@ari/contracts/rpc'
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
import { useRemoteAccess } from './use-remote-access'

const log = createLogger('settings:remote')

/** Guided connection setup and explicit device grants for the mobile workbench. */
export function RemoteSettings() {
  const {
    remote,
    tailscale,
    connect,
    projects,
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
    projectIds: string[]
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
  const saveGrants = (deviceId: string, projectIds: string[], allowTerminal: boolean): void => {
    run('Save device access', async () => {
      setRemote(
        await rpc.invoke('remote.updateDeviceGrants', { deviceId, projectIds, allowTerminal }),
      )
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
  const canServe =
    remote?.enabled === true && tailscale?.installed === true && tailscale.origin !== null
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
      description="Your Ari workspace, wherever you are."
    >
      <section
        aria-label="Connection status"
        className="flex items-center gap-3 rounded-xl border border-border bg-surface-1 px-4 py-3.5"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-muted">
          <Monitor size={16} strokeWidth={1.7} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">{status}</p>
          <p className="mt-0.5 text-[13px] leading-5 text-fg-subtle">
            Agents and projects stay on this computer. You decide which phones can access them.
          </p>
        </div>
        {reachable ? <span className="ari-status" data-status="done" aria-hidden="true" /> : null}
      </section>

      {error !== null || remote?.error != null ? (
        <div className="rounded-xl border border-border bg-surface-1 px-4 py-3.5">
          <p role="alert" className="flex items-start gap-2.5 text-[13px] leading-5 text-danger">
            <span className="ari-status mt-[3px]" data-status="error" aria-hidden="true" />
            <span className="min-w-0">{error ?? remote?.error}</span>
          </p>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={disabled} className="mt-2">
            Retry checks
          </Button>
        </div>
      ) : null}

      <SettingsSection title="Connection method" headingId="remote-method-heading" bare>
        <div role="group" aria-label="Connection method" className="grid gap-2.5 sm:grid-cols-2">
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
              className={`flex items-start gap-3 rounded-xl border bg-surface-1 px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-60 ${method === option.id ? 'border-fg' : 'border-border hover:border-border-strong'}`}
            >
              <option.icon
                size={16}
                strokeWidth={1.7}
                aria-hidden="true"
                className={
                  method === option.id
                    ? 'mt-0.5 shrink-0 text-fg'
                    : 'mt-0.5 shrink-0 text-fg-subtle'
                }
              />
              <span>
                <span className="block text-sm font-medium text-fg">{option.title}</span>
                <span className="mt-0.5 block text-[13px] leading-5 text-fg-subtle">
                  {option.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      </SettingsSection>

      <section aria-label="Mobile connection setup" className={SETTINGS_CARD_CLASS}>
        <section aria-labelledby="remote-access-heading" className="pt-3.5">
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
            hint="Starts the local gateway. Paired devices keep their grants when you turn it off."
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
            <p role="status" className="px-4 py-3.5 text-[13px] text-fg-subtle">
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
          <section aria-labelledby="remote-tailscale-heading" className="space-y-3 px-4 py-3.5">
            <Step
              number="2"
              title="Connect your private network"
              id="remote-tailscale-heading"
              done={tailscale?.serving === true}
            />
            <p className="text-sm leading-relaxed text-fg-muted">
              {tailscale?.error ?? tailscaleSummary(tailscale)}
            </p>
            {tailscale?.installed === false ? (
              <p className="text-[13px] leading-5 text-fg-subtle">
                Install Tailscale on this computer and phone, then sign both into the same network.
              </p>
            ) : tailscale?.origin === null ? (
              <p className="text-[13px] leading-5 text-fg-subtle">
                Open Tailscale on this computer and sign in, then check again.
              </p>
            ) : (
              <p className="text-[13px] leading-5 text-fg-subtle">
                Your phone must be connected to the same Tailscale network. Serve exposes only
                Ari&apos;s gateway.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {tailscale?.serving === true ? (
                <Button
                  disabled={disabled}
                  onClick={() =>
                    run('Stop Tailscale Serve', async () =>
                      setTailscale(await rpc.invoke('remote.tailscale.disable')),
                    )
                  }
                >
                  Stop serving Ari
                </Button>
              ) : (
                <Button
                  disabled={!canServe || disabled}
                  onClick={() =>
                    run('Start Tailscale Serve', async () => {
                      const state = await rpc.invoke('remote.tailscale.enable')
                      setRemote(state.remote)
                      setTailscale(state.tailscale)
                    })
                  }
                >
                  Serve Ari over Tailscale
                </Button>
              )}
              <Button variant="ghost" disabled={disabled} onClick={refresh}>
                Check connection
              </Button>
            </div>
          </section>
        )}

        <section aria-labelledby="remote-pairing-heading" className="space-y-3 px-4 py-3.5">
          <Step
            number="3"
            title="Pair your phone"
            id="remote-pairing-heading"
            done={(remote?.devices.length ?? 0) > 0}
          />
          {remote?.enabled !== true ? (
            <p className="text-sm text-fg-muted">Turn remote access on to pair a phone.</p>
          ) : !reachable ? (
            <p className="text-sm leading-relaxed text-fg-muted">
              No address a phone can reach exists yet. Complete the connection step above, then
              create an invitation.
            </p>
          ) : invitation === null || expired || !invitationMatches ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-fg-muted">
                {expired
                  ? 'The invitation expired. Create a new code to pair.'
                  : 'Scan a code, then confirm your phone on this computer.'}
              </p>
              <Button
                variant="primary"
                disabled={disabled}
                onClick={() =>
                  mutate('Create pairing invitation', () => rpc.invoke('remote.invite', { method }))
                }
              >
                Show pairing code
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-5 border-t border-border pt-3.5">
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
                <p className="text-sm font-medium text-fg">Scan with your phone&apos;s camera</p>
                <p className="text-[13px] leading-5 text-fg-subtle">
                  {managedPairing
                    ? 'This invitation uses Ari Connect.'
                    : 'Keep Tailscale connected.'}{' '}
                  Approve access here after the phone shows a matching code.
                </p>
                {invitation.code === null ? (
                  <p role="status" className="text-[13px] leading-5 text-fg-muted">
                    Too many wrong codes were entered. The QR still works; cancel and show a new
                    pairing code to type one again.
                  </p>
                ) : invitation.code !== undefined ? (
                  <div>
                    <p className="font-mono text-xl font-medium text-fg">
                      {invitation.code.slice(0, 4)}-{invitation.code.slice(4)}
                    </p>
                    <p className="mt-1 text-[13px] leading-5 text-fg-subtle">
                      On an installed app, enter this code instead of scanning.
                    </p>
                  </div>
                ) : null}
                <p className="text-[13px] text-fg-subtle">
                  Expires {formatTime(invitation.expiresAt)}.
                </p>
                <details className="text-[13px] text-fg-subtle">
                  <summary className="cursor-pointer py-1.5">Invitation address</summary>
                  <code className="block break-all font-mono text-[13px] text-fg-subtle">
                    {invitation.url}
                  </code>
                </details>
                <Button
                  variant="ghost"
                  disabled={disabled}
                  onClick={() =>
                    mutate('Cancel invitation', () => rpc.invoke('remote.cancelInvite'))
                  }
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
          projects={projects}
          disabled={disabled}
          expired={pending.expiresAt <= now}
          approve={(projectIds, allowTerminal) =>
            mutate('Approve device', () =>
              rpc.invoke('remote.approve', {
                invitationId: pending.invitationId,
                confirmationCode: pending.confirmationCode,
                projectIds,
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
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-1 px-4 py-3.5">
            <Smartphone
              size={16}
              strokeWidth={1.7}
              className="shrink-0 text-fg-subtle"
              aria-hidden="true"
            />
            <p className="text-[13px] text-fg-subtle">No phones are paired yet.</p>
          </div>
        ) : (
          <ul className={SETTINGS_CARD_CLASS}>
            {remote?.devices.map((device) => (
              <li
                key={device.deviceId}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium text-fg">{device.displayName}</p>
                  <p className="text-[13px] text-fg-subtle">
                    {device.lastSeenAt === null
                      ? 'Never connected'
                      : `Last seen ${formatTime(device.lastSeenAt)}`}
                  </p>
                  <p className="text-[13px] text-fg-subtle">
                    Projects: {grantedProjects(device.projectIds, projects)}
                  </p>
                  <p className="text-[13px] text-fg-subtle">
                    Terminal: {device.allowTerminal === true ? 'enabled' : 'not granted'}
                  </p>
                </div>
                {editing?.deviceId === device.deviceId ? (
                  <div className="w-full space-y-3 border-t border-border pt-3">
                    <p className="text-sm font-medium text-fg">Access for {device.displayName}</p>
                    <DeviceAccessPicker
                      projects={projects}
                      projectIds={editing.projectIds}
                      allowTerminal={editing.allowTerminal}
                      disabled={disabled}
                      onChange={(projectIds, allowTerminal) =>
                        setEditing({ deviceId: device.deviceId, projectIds, allowTerminal })
                      }
                    />
                    <p className="text-[13px] leading-5 text-fg-subtle">
                      Changes apply the next time this phone connects. It does not need to pair
                      again.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="primary"
                        disabled={disabled}
                        onClick={() =>
                          saveGrants(device.deviceId, editing.projectIds, editing.allowTerminal)
                        }
                        aria-label={`Save access for ${device.displayName}`}
                      >
                        Save access
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => setEditing(null)}
                        aria-label={`Cancel access for ${device.displayName}`}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : confirmingRevoke === device.deviceId ? (
                  <div className="space-y-2">
                    <p className="text-[13px] text-fg-subtle">
                      This phone will need to pair again.
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
                      >
                        Confirm revoke
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => setConfirmingRevoke(null)}
                        aria-label={`Keep ${device.displayName}`}
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
                          projectIds: [...device.projectIds],
                          allowTerminal: device.allowTerminal === true,
                        })
                      }}
                      aria-label={`Edit access for ${device.displayName}`}
                    >
                      Edit access
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => setConfirmingRevoke(device.deviceId)}
                      aria-label={`Revoke ${device.displayName}`}
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
      <details className="rounded-xl border border-border bg-surface-1 px-4 text-[13px] text-fg-subtle">
        <summary className="cursor-pointer rounded-xl py-3.5 text-sm font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring">
          Connection diagnostics
        </summary>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 pb-3.5">
          <dt>Gateway</dt>
          <dd className="break-all font-mono text-[12.5px] text-fg-muted">
            {remote?.origin ?? 'Not running'}
          </dd>
          <dt>Phone address</dt>
          <dd className="break-all font-mono text-[12.5px] text-fg-muted">
            {clientUrl ?? 'Not available'}
          </dd>
          <dt>Tailscale host</dt>
          <dd className="break-all font-mono text-[12.5px] text-fg-muted">
            {tailscale?.dnsName ?? 'Not detected'}
          </dd>
        </dl>
        <p className="pb-3.5 leading-5">
          A reachable address is not authorization. Each phone needs its own approved pairing. This
          computer must stay awake for mobile access.
        </p>
      </details>
      {busy !== null ? (
        <p role="status" className="flex items-center gap-2 text-[13px] text-fg-subtle">
          <span className="ari-status" data-status="working" aria-hidden="true" />
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
    <h2 id={id} className="flex items-center gap-2.5 text-sm font-medium text-fg">
      <span
        aria-hidden="true"
        className="flex size-5 items-center justify-center rounded-sm bg-surface-2 text-xs font-medium tabular-nums text-fg-muted"
      >
        {done ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : number}
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

function grantedProjects(projectIds: readonly string[], projects: readonly Project[]): string {
  if (projectIds.length === 0) return 'none'
  return projectIds
    .map((id) => projects.find((project) => project.id === id)?.name ?? id)
    .join(', ')
}

function tailscaleSummary(state: TailscaleState | null): string {
  if (state === null) return 'Checking Tailscale...'
  if (!state.installed) return 'Tailscale is not installed on this computer.'
  if (state.origin === null)
    return 'Tailscale is installed, but this computer is not connected to a tailnet yet.'
  if (state.serving) return `Serving Ari at ${state.origin}.`
  return 'Tailscale is connected; Ari is not served to the tailnet yet.'
}
