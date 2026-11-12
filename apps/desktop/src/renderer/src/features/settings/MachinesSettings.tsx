import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Monitor, Radar, RefreshCw } from 'lucide-react'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { Select } from '@ari/ui/select'
import { Switch } from '@ari/ui/switch'
import {
  machineDiscoverySchema,
  machinePairingViewSchema,
  type MachineDiscovery,
  type MachinePairingView,
  type MachineView,
} from '@ari/contracts/machines'
import { rpc } from '../../lib/rpc'
import { cx, iconButton, tab as tabClass, tabSelected, textButton } from '../../lib/recipes'
import { useMachines } from '../machines/use-machines'
import { messageOf } from '../machines/remote-client'
import { SettingsPage } from './SettingsPage'
import { SettingsRow, SETTINGS_ROW_CLASS } from './SettingsRow'
import {
  SettingsCard,
  SettingsSection,
  SETTINGS_HINT_CLASS,
  SETTINGS_LABEL_CLASS,
} from './SettingsSection'

type MachineStatus = MachineView['status']

/** The shared status glyph and a plain word for each connection state. */
const STATUS: Record<MachineStatus, { glyph: string; label: string }> = {
  connected: { glyph: 'done', label: 'Connected' },
  offline: { glyph: 'idle', label: 'Offline' },
  pairing: { glyph: 'attention', label: 'Waiting for approval' },
  unpaired: { glyph: 'idle', label: 'Not paired' },
  revoked: { glyph: 'error', label: 'Access revoked' },
  incompatible: { glyph: 'error', label: 'Needs an update' },
}

const TIERS = [
  { value: 'prefer', label: 'Prefer' },
  { value: 'normal', label: 'Normal' },
  { value: 'less-often', label: 'Less often' },
  { value: 'manual-only', label: 'Manual only' },
]

/** A notice row inside a card: a glyph, a sentence, and its actions. */
function NoticeRow({
  tone,
  children,
  actions,
}: {
  tone: 'attention' | 'error'
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span aria-hidden className="ari-status mt-[3px]" data-status={tone} />
      <div className="min-w-0 flex-1 text-[13px] text-fg">{children}</div>
      {actions != null ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function MachinesSettings({
  onOpenMachine,
  onHosting,
}: {
  onOpenMachine?: (machineId: string) => void
  onHosting?: () => void
}) {
  const { machines, error, refresh, preferences, refreshInventory, inventories, localModels } =
    useMachines()
  const availableCount =
    Number(
      localModels?.providers.some(
        (provider) =>
          provider.available !== false &&
          provider.installed !== false &&
          provider.authStatus !== 'unauthenticated' &&
          provider.models.length > 0,
      ) === true,
    ) +
    machines.filter(
      (machine) =>
        machine.status === 'connected' &&
        machine.versionReady !== false &&
        machine.permissionsReady !== false &&
        inventories.get(machine.id)?.permissions &&
        inventories
          .get(machine.id)
          ?.catalog?.providers.some(
            (provider) =>
              provider.available !== false &&
              provider.installed !== false &&
              provider.authStatus !== 'unauthenticated' &&
              provider.models.length > 0,
          ),
    ).length
  const [address, setAddress] = useState('')
  const [peers, setPeers] = useState<MachineDiscovery[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setFailure(null)
    try {
      await action()
      await refresh()
      await refreshInventory()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsPage
      title="Machines"
      description="Run projects, agents and terminals on another computer over your private Tailscale network."
    >
      <div className="space-y-8">
        <SettingsSection title="Add a computer">
          <form
            className={cx(SETTINGS_ROW_CLASS, 'gap-2')}
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                await rpc.invoke('machines.add', { address: address.trim() })
                setAddress('')
              })
            }}
          >
            <Input
              aria-label="Tailnet URL or pairing link"
              className="min-w-0 flex-1 font-mono text-[13px]"
              placeholder="https://workstation.your-tailnet.ts.net"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              autoComplete="off"
            />
            <Button
              className="shrink-0"
              type="submit"
              variant="primary"
              disabled={busy || !address.trim()}
            >
              Add computer
            </Button>
          </form>
          <SettingsRow
            label="Find computers on your tailnet"
            hint="Lists computers running Ari. Nothing pairs until you add one."
          >
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setPeers(
                    machineDiscoverySchema.array().parse(await rpc.invoke('machines.discover')),
                  ),
                )
              }
            >
              <Radar size={14} strokeWidth={1.7} aria-hidden />
              Discover computers
            </Button>
          </SettingsRow>
          {peers.map((peer) => (
            <div key={peer.routes[0]?.origin ?? peer.name} className={SETTINGS_ROW_CLASS}>
              <div className="flex min-w-0 items-center gap-3">
                <Monitor
                  size={16}
                  strokeWidth={1.7}
                  aria-hidden
                  className="shrink-0 text-fg-subtle"
                />
                <div className="min-w-0">
                  <p className={SETTINGS_LABEL_CLASS}>{peer.name}</p>
                  <p className="truncate font-mono text-xs text-fg-subtle">
                    {peer.routes[0]?.origin}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                disabled={busy || peer.routes.length === 0}
                onClick={() =>
                  void run(() =>
                    rpc.invoke('machines.add', {
                      address: peer.routes[0]!.origin,
                      name: peer.name,
                    }),
                  )
                }
              >
                Add
              </Button>
            </div>
          ))}
        </SettingsSection>

        {availableCount >= 2 && (
          <SettingsSection
            title="Auto"
            description="Auto picks one machine for each new draft from fresh CPU and memory data. A busy machine needs a manual choice."
          >
            <SettingsRow label="Start new project drafts with Auto">
              <Switch
                aria-label="Start new project drafts with Auto"
                checked={preferences.autoEnabled}
                disabled={busy}
                onCheckedChange={(checked) =>
                  void run(() => rpc.invoke('machines.setAuto', { enabled: checked }))
                }
              />
            </SettingsRow>
            {[{ id: 'local', name: 'This PC' }, ...machines].map((host) => (
              <SettingsRow key={host.id} label={host.name}>
                <Select
                  aria-label={`Auto preference for ${host.name}`}
                  disabled={busy}
                  value={preferences.hostTiers[host.id] ?? 'normal'}
                  options={TIERS}
                  onValueChange={(tier) =>
                    void run(() =>
                      rpc.invoke('machines.setPreference', {
                        machineId: host.id,
                        tier: tier as 'prefer' | 'normal' | 'less-often' | 'manual-only',
                      }),
                    )
                  }
                  className="w-36"
                />
              </SettingsRow>
            ))}
          </SettingsSection>
        )}

        <SettingsSection
          title="Your computers"
          bare
          action={
            <button
              type="button"
              className={textButton}
              disabled={busy}
              onClick={() => void refresh()}
            >
              <RefreshCw size={13} strokeWidth={1.7} aria-hidden />
              Refresh
            </button>
          }
        >
          {machines.length === 0 ? (
            <SettingsCard>
              <div className="flex items-center gap-3 px-4 py-3.5">
                <Monitor
                  size={16}
                  strokeWidth={1.7}
                  aria-hidden
                  className="shrink-0 text-fg-subtle"
                />
                <div className="min-w-0">
                  <p className={SETTINGS_LABEL_CLASS}>No remote computers yet</p>
                  <p className={cx('mt-0.5', SETTINGS_HINT_CLASS)}>
                    Add the Tailscale address shown in Mobile access on the host.
                  </p>
                </div>
              </div>
            </SettingsCard>
          ) : (
            <div className="space-y-3">
              {machines.map((machine) => (
                <MachineCard
                  key={machine.id}
                  machine={machine}
                  onChanged={refresh}
                  onOpen={onOpenMachine}
                />
              ))}
            </div>
          )}
        </SettingsSection>

        {(failure ?? error) !== null && (
          <p role="alert" className="text-[13px] text-danger">
            {failure ?? error}
          </p>
        )}

        <SettingsSection title="Host this computer">
          <SettingsRow
            label="Let other computers connect"
            hint="Approve them in Mobile access after comparing the code on both screens. Terminal access is a separate grant."
          >
            {onHosting && <Button onClick={onHosting}>Open Mobile access</Button>}
          </SettingsRow>
        </SettingsSection>
      </div>
    </SettingsPage>
  )
}

function MachineCard({
  machine,
  onChanged,
  onOpen,
}: {
  machine: MachineView
  onChanged: () => Promise<void>
  onOpen?: (machineId: string) => void
}) {
  const [name, setName] = useState(machine.name)
  const [renaming, setRenaming] = useState(false)
  const [detail, setDetail] = useState<'routes' | 'permissions'>('routes')
  const [routeAddress, setRouteAddress] = useState('')
  const { inventories } = useMachines()
  const inventory = inventories.get(machine.id)
  const [code, setCode] = useState('')
  const [displayName, setDisplayName] = useState('Ari desktop')
  const [pairing, setPairing] = useState<MachinePairingView | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      await action()
      await onChanged()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    setName(machine.name)
  }, [machine.name])
  useEffect(() => {
    if (machine.status !== 'pairing') return
    let alive = true
    const check = async () => {
      try {
        const result = machinePairingViewSchema.parse(
          await rpc.invoke('machines.pairStatus', { machineId: machine.id }),
        )
        if (!alive || result.machineId !== machine.id) return
        setPairing(result)
        if (result.status !== 'pairing') await onChanged()
      } catch (error) {
        if (alive) setFailure(messageOf(error))
      }
    }
    void check()
    const timer = setInterval(() => void check(), 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [machine.id, machine.status, onChanged])

  const status = STATUS[machine.status]
  const version = inventory?.version?.ariVersion ?? machine.identity?.ariVersion
  const facts = [
    version ? `Ari ${version}` : 'Version unavailable',
    machine.allowTerminal ? 'Terminal granted' : 'Terminal not granted',
    inventory?.version
      ? inventory.version.hostingMode === 'headless'
        ? 'Headless host'
        : 'Desktop host'
      : null,
  ].filter((fact): fact is string => fact !== null)
  const guidance =
    inventory?.version?.update.guidance ??
    (machine.status === 'incompatible'
      ? 'Update Ari in Settings on this host, then reconnect.'
      : null)

  return (
    <article aria-label={machine.name}>
      <SettingsCard>
        {/* Who and where, with the actions at the right. */}
        <div className="flex items-start gap-3 px-4 py-3.5">
          <Monitor
            size={16}
            strokeWidth={1.7}
            aria-hidden
            className="mt-0.5 shrink-0 text-fg-subtle"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className={cx(SETTINGS_LABEL_CLASS, 'truncate')}>{machine.name}</h3>
              <span className="flex shrink-0 items-center gap-1 text-xs text-fg-subtle">
                <span aria-hidden className="ari-status" data-status={status.glyph} />
                {status.label}
              </span>
            </div>
            {machine.routes[0] ? (
              <p
                className="mt-0.5 truncate font-mono text-xs text-fg-subtle"
                title={machine.routes[0].origin}
              >
                {machine.routes[0].origin}
              </p>
            ) : null}
            <p className={cx('mt-0.5', SETTINGS_HINT_CLASS)}>{facts.join(' · ')}</p>
            {guidance ? <p className={SETTINGS_HINT_CLASS}>{guidance}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onOpen && (
              <Button
                size="sm"
                variant="primary"
                disabled={machine.status !== 'connected' || busy}
                onClick={() => onOpen(machine.id)}
              >
                New session
              </Button>
            )}
            {(machine.status === 'offline' || machine.status === 'connected') && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run(() => rpc.invoke('machines.connect', { machineId: machine.id }))
                }
              >
                Reconnect
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-pressed={renaming}
              onClick={() => setRenaming((value) => !value)}
            >
              Rename
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </div>
        </div>

        {renaming && (
          <form
            className={cx(SETTINGS_ROW_CLASS, 'gap-2')}
            onSubmit={(event) => {
              event.preventDefault()
              void run(() =>
                rpc
                  .invoke('machines.rename', { machineId: machine.id, name: name.trim() })
                  .then(() => setRenaming(false)),
              )
            }}
          >
            <Input
              aria-label={`Name for ${machine.name}`}
              value={name}
              maxLength={80}
              className="min-w-0 flex-1"
              onChange={(event) => setName(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              disabled={busy || !name.trim() || name === machine.name}
            >
              Save name
            </Button>
          </form>
        )}

        {removing && (
          <div role="alertdialog" aria-label={`Remove ${machine.name}`}>
            <NoticeRow
              tone="error"
              actions={
                <>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() =>
                      void run(() => rpc.invoke('machines.remove', { machineId: machine.id }))
                    }
                  >
                    Remove computer
                  </Button>
                </>
              }
            >
              Remove this computer and its saved pairing?
            </NoticeRow>
          </div>
        )}

        {(machine.status === 'unpaired' || machine.status === 'revoked') && (
          <form
            className="flex flex-wrap items-end gap-2 px-4 py-3.5"
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                const result = machinePairingViewSchema.parse(
                  await rpc.invoke('machines.pair', {
                    machineId: machine.id,
                    displayName: displayName.trim(),
                    ...(code.trim() ? { code: code.trim() } : {}),
                  }),
                )
                if (result.machineId === machine.id) setPairing(result)
              })
            }}
          >
            <label className="min-w-40 flex-1 text-xs text-fg-subtle">
              This computer&apos;s display name
              <Input
                className="mt-1 w-full"
                value={displayName}
                maxLength={80}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <label className="min-w-40 flex-1 text-xs text-fg-subtle">
              Pairing code from host
              <Input
                className="mt-1 w-full font-mono"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="ABCD-EFGH"
                maxLength={64}
              />
            </label>
            <Button type="submit" variant="primary" disabled={busy || !displayName.trim()}>
              Request pairing
            </Button>
          </form>
        )}

        {(pairing !== null || machine.status === 'pairing') && machine.status !== 'connected' && (
          <NoticeRow tone="attention">
            <p className="font-medium">
              {pairing?.status === 'pairing' || pairing === null
                ? 'Waiting for host approval'
                : `Pairing ${pairing.status}`}
            </p>
            <p className={cx('mt-0.5', SETTINGS_HINT_CLASS)}>
              Compare this code on the host, then approve this computer in Mobile access.
              {pairing?.expiresAt
                ? ` Expires ${new Date(pairing.expiresAt).toLocaleTimeString()}.`
                : ''}
            </p>
            {pairing?.confirmationCode && (
              <p className="mt-2 font-mono text-[18px] tracking-[0.2em] text-fg">
                {pairing.confirmationCode}
              </p>
            )}
            {pairing?.error && (
              <p role="alert" className="mt-1 text-[13px] text-danger">
                {pairing.error}
              </p>
            )}
          </NoticeRow>
        )}

        {machine.status === 'incompatible' && (
          <NoticeRow tone="attention">
            Update Ari on the host before pairing or sending commands.
          </NoticeRow>
        )}

        {(failure ?? machine.error) && (
          <p role="alert" className="px-4 py-3 text-[13px] text-danger">
            {failure ??
              (typeof machine.error === 'string' ? machine.error : messageOf(machine.error))}
          </p>
        )}

        {/* Connection details: the routes Ari tries, and what the host granted. */}
        <div className="px-4 pb-3.5 pt-2.5">
          <div
            className="-ml-2.5 mb-1.5 flex gap-0.5"
            role="tablist"
            aria-label={`Connection details for ${machine.name}`}
          >
            {(['routes', 'permissions'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={detail === tab}
                onClick={() => setDetail(tab)}
                className={cx(tabClass, detail === tab && tabSelected)}
              >
                {tab === 'routes' ? 'Routes' : 'Your permissions'}
              </button>
            ))}
          </div>
          {detail === 'routes' ? (
            <div role="tabpanel" aria-label="Routes">
              <ul className="divide-y divide-border">
                {machine.routes.map((route, index) => (
                  <li key={route.origin} className="flex items-center gap-2 py-2">
                    <span
                      aria-hidden
                      className="ari-status"
                      data-status={machine.effectiveRoute === route.origin ? 'done' : 'idle'}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[13px] text-fg" title={route.origin}>
                        {route.origin}
                      </p>
                      <p className="text-xs text-fg-subtle">
                        {route.source === 'learned' ? 'Learned from host' : 'Saved route'}
                        {machine.effectiveRoute === route.origin ? ' · Connected' : ''}
                      </p>
                    </div>
                    {([-1, 1] as const).map((delta) => (
                      <button
                        key={delta}
                        type="button"
                        className={iconButton}
                        aria-label={`${delta < 0 ? 'Move up' : 'Move down'} route ${route.origin}`}
                        disabled={
                          busy || index + delta < 0 || index + delta >= machine.routes.length
                        }
                        onClick={() =>
                          void run(() => {
                            const origins = machine.routes.map((entry) => entry.origin)
                            ;[origins[index], origins[index + delta]] = [
                              origins[index + delta]!,
                              origins[index]!,
                            ]
                            return rpc.invoke('machines.reorderRoutes', {
                              machineId: machine.id,
                              origins,
                            })
                          })
                        }
                      >
                        {delta < 0 ? (
                          <ArrowUp size={14} strokeWidth={1.7} aria-hidden />
                        ) : (
                          <ArrowDown size={14} strokeWidth={1.7} aria-hidden />
                        )}
                      </button>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || route.source === 'learned' || machine.routes.length <= 1}
                      title={
                        route.source === 'learned'
                          ? 'Learned routes follow the host and cannot be removed.'
                          : undefined
                      }
                      onClick={() =>
                        void run(() =>
                          rpc.invoke('machines.removeRoute', {
                            machineId: machine.id,
                            origin: route.origin,
                          }),
                        )
                      }
                    >
                      Remove route
                    </Button>
                  </li>
                ))}
              </ul>
              <form
                className="mt-1.5 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void run(async () => {
                    await rpc.invoke('machines.addRoute', {
                      machineId: machine.id,
                      address: routeAddress.trim(),
                    })
                    setRouteAddress('')
                  })
                }}
              >
                <Input
                  className="min-w-0 flex-1 font-mono text-[13px]"
                  aria-label={`New route for ${machine.name}`}
                  value={routeAddress}
                  onChange={(event) => setRouteAddress(event.target.value)}
                  placeholder="https://machine.tailnet.ts.net"
                />
                <Button type="submit" size="sm" disabled={busy || !routeAddress.trim()}>
                  Add route
                </Button>
              </form>
            </div>
          ) : (
            <div role="tabpanel" aria-label="Your permissions">
              <dl className="divide-y divide-border text-[13px]">
                <Fact label="Route" value={machine.effectiveRoute ?? 'Not connected'} mono />
                {machine.status === 'connected' && inventory?.permissions ? (
                  <>
                    <Fact
                      label="Terminal"
                      value={inventory.permissions.allowTerminal ? 'Allowed' : 'Not allowed'}
                    />
                    <Fact
                      label="Projects"
                      value={
                        inventory.permissions.projectScope.kind === 'all'
                          ? 'All host projects'
                          : inventory.permissions.projectScope.projectIds
                              .map(
                                (id) =>
                                  inventory.projects.find((project) => project.id === id)?.name ??
                                  id,
                              )
                              .join(', ') || 'None'
                      }
                    />
                    {inventory.permissions.managedLeaseExpiresAt && (
                      <Fact
                        label="Access expires"
                        value={new Date(
                          inventory.permissions.managedLeaseExpiresAt,
                        ).toLocaleTimeString()}
                      />
                    )}
                  </>
                ) : (
                  <p className={cx('py-2', SETTINGS_HINT_CLASS)}>
                    Reconnect to read the permissions granted to this computer.
                  </p>
                )}
              </dl>
            </div>
          )}
        </div>
      </SettingsCard>
    </article>
  )
}

/** One label and value in the permissions list. */
function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="shrink-0 text-fg-subtle">{label}</dt>
      <dd className={cx('min-w-0 truncate text-right text-fg', mono && 'font-mono text-xs')}>
        {value}
      </dd>
    </div>
  )
}
