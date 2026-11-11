import { useEffect, useState } from 'react'
import { Monitor, Radar, RefreshCw } from 'lucide-react'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import {
  machineDiscoverySchema,
  machinePairingViewSchema,
  type MachineDiscovery,
  type MachinePairingView,
  type MachineView,
} from '@ari/contracts/machines'
import { rpc } from '../../lib/rpc'
import { useMachines } from '../machines/use-machines'
import { messageOf } from '../machines/remote-client'
import { SettingsPage } from './SettingsPage'

export function MachinesSettings({ onOpenMachine, onHosting }: {
  onOpenMachine?: (machineId: string) => void
  onHosting?: () => void
}) {
  const { machines, error, refresh } = useMachines()
  const [address, setAddress] = useState('')
  const [peers, setPeers] = useState<MachineDiscovery[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setFailure(null)
    try { await action(); await refresh() } catch (error) { setFailure(messageOf(error)) }
    finally { setBusy(false) }
  }
  return <SettingsPage title="Machines" description="Work on another computer over your private Tailscale network. Projects, agents, and terminals run on that computer.">
    <section aria-labelledby="machines-add" className="space-y-3">
      <h2 id="machines-add" className="text-sm font-medium text-fg">Add a computer</h2>
      <form className="flex items-end gap-2" onSubmit={(event) => {
        event.preventDefault()
        void run(async () => { await rpc.invoke('machines.add', { address: address.trim() }); setAddress('') })
      }}>
        <label className="min-w-0 flex-1 text-xs text-fg-muted">Tailnet URL or pairing link
          <Input className="mt-2 w-full" placeholder="https://workstation.your-tailnet.ts.net" value={address} onChange={(event) => setAddress(event.target.value)} autoComplete="off" />
        </label>
        <Button type="submit" variant="primary" disabled={busy || !address.trim()}>Add computer</Button>
      </form>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={() => void run(async () => setPeers(machineDiscoverySchema.array().parse(await rpc.invoke('machines.discover'))))}><Radar size={14} />Discover computers</Button>
        <span className="text-xs text-fg-subtle">Discovery never pairs automatically.</span>
      </div>
      {peers.map((peer) => <div key={peer.routes[0]?.origin ?? peer.name} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
        <div className="min-w-0"><p className="text-sm text-fg">{peer.name}</p><p className="truncate text-xs text-fg-muted">{peer.routes[0]?.origin}</p></div>
        <Button size="sm" disabled={busy || peer.routes.length === 0} onClick={() => void run(() => rpc.invoke('machines.add', { address: peer.routes[0]!.origin, name: peer.name }))}>Add</Button>
      </div>)}
    </section>
    <section aria-labelledby="machines-list">
      <div className="mb-3 flex items-center justify-between"><h2 id="machines-list" className="text-sm font-medium text-fg">Your computers</h2><Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}><RefreshCw size={13} />Refresh</Button></div>
      {machines.length === 0 ? <div className="rounded-lg border border-dashed border-border p-8 text-center"><Monitor size={25} className="mx-auto mb-3 text-fg-subtle" /><p className="text-sm text-fg">No remote computers yet</p><p className="mt-1 text-xs text-fg-muted">Add the Tailscale address shown in Mobile access on the host.</p></div> : <div className="divide-y divide-border rounded-lg border border-border bg-surface-1">{machines.map((machine) => <MachineRow key={machine.id} machine={machine} onChanged={refresh} onOpen={onOpenMachine} />)}</div>}
    </section>
    {(failure ?? error) !== null && <p role="alert" className="text-sm text-danger">{failure ?? error}</p>}
    <section className="border-t border-border pt-5"><h2 className="text-sm font-medium">Host this computer</h2><p className="mt-1 text-xs leading-relaxed text-fg-muted">Approve phones and computers in Mobile access. Compare the confirmation code on both screens. Terminal access needs a separate host grant.</p>{onHosting && <Button className="mt-3" size="sm" onClick={onHosting}>Open Mobile access</Button>}</section>
  </SettingsPage>
}

function MachineRow({ machine, onChanged, onOpen }: {
  machine: MachineView
  onChanged: () => Promise<void>
  onOpen?: (machineId: string) => void
}) {
  const [name, setName] = useState(machine.name)
  const [code, setCode] = useState('')
  const [displayName, setDisplayName] = useState('Ari desktop')
  const [pairing, setPairing] = useState<MachinePairingView | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setFailure(null)
    try { await action(); await onChanged() } catch (error) { setFailure(messageOf(error)) }
    finally { setBusy(false) }
  }
  useEffect(() => { setName(machine.name) }, [machine.name])
  useEffect(() => {
    if (machine.status !== 'pairing') return
    let alive = true
    const check = async () => {
      try {
        const result = machinePairingViewSchema.parse(await rpc.invoke('machines.pairStatus', { machineId: machine.id }))
        if (!alive || result.machineId !== machine.id) return
        setPairing(result)
        if (result.status !== 'pairing') await onChanged()
      } catch (error) { if (alive) setFailure(messageOf(error)) }
    }
    void check()
    const timer = setInterval(() => void check(), 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [machine.id, machine.status, onChanged])
  return <article className="p-4" aria-label={machine.name}>
    <div className="flex items-start gap-3"><Monitor size={19} className="mt-1 shrink-0 text-fg-muted" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="truncate text-sm font-medium">{machine.name}</h3><span className={`rounded px-1.5 py-0.5 text-xs ${machine.status === 'connected' ? 'bg-success/10 text-success' : 'bg-surface-3 text-fg-muted'}`}>{machine.status}</span></div><p className="mt-1 truncate text-xs text-fg-muted">{machine.routes[0]?.origin}</p><p className="mt-1 text-xs text-fg-subtle">{machine.identity?.ariVersion ? `Ari ${machine.identity.ariVersion}` : 'Legacy host identity'} · {machine.allowTerminal ? 'Terminal granted' : 'Terminal not granted'}</p></div></div>
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {onOpen && <Button size="sm" disabled={machine.status !== 'connected' || busy} onClick={() => onOpen(machine.id)}>Open workspace</Button>}
      {(machine.status === 'offline' || machine.status === 'connected') && <Button size="sm" disabled={busy} onClick={() => void run(() => rpc.invoke('machines.connect', { machineId: machine.id }))}>Reconnect</Button>}
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void run(() => rpc.invoke('machines.rename', { machineId: machine.id, name: name.trim() })) }}><Input aria-label={`Name for ${machine.name}`} value={name} maxLength={80} className="h-7 w-40 text-xs" onChange={(event) => setName(event.target.value)} /><Button type="submit" size="sm" disabled={busy || !name.trim() || name === machine.name}>Rename</Button></form>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>Remove</Button>
    </div>
    {(machine.status === 'unpaired' || machine.status === 'revoked') && <form className="mt-4 space-y-3 border-t border-border pt-4" onSubmit={(event) => { event.preventDefault(); void run(async () => { const result = machinePairingViewSchema.parse(await rpc.invoke('machines.pair', { machineId: machine.id, displayName: displayName.trim(), ...(code.trim() ? { code: code.trim() } : {}) })); if (result.machineId === machine.id) setPairing(result) }) }}><div className="flex gap-3"><label className="flex-1 text-xs text-fg-muted">This computer's display name<Input className="mt-1 w-full" value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} /></label><label className="flex-1 text-xs text-fg-muted">Pairing code from host<Input className="mt-1 w-full font-mono" value={code} onChange={(event) => setCode(event.target.value)} placeholder="ABCD-EFGH" maxLength={64} /></label></div><Button type="submit" size="sm" disabled={busy || !displayName.trim()}>Request pairing</Button></form>}
    {(pairing !== null || machine.status === 'pairing') && machine.status !== 'connected' && <div className="mt-4 rounded-md border border-border bg-surface-2 p-3"><p className="text-sm font-medium">{pairing?.status === 'pairing' || pairing === null ? 'Waiting for host approval' : `Pairing ${pairing.status}`}</p>{pairing?.confirmationCode && <p className="mt-2 font-mono text-lg tracking-widest">{pairing.confirmationCode}</p>}<p className="mt-2 text-xs text-fg-muted">Compare this code on the host, then approve this computer in Mobile access.</p>{pairing?.expiresAt && <p className="mt-1 text-xs text-fg-subtle">Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</p>}{pairing?.error && <p role="alert" className="mt-2 text-xs text-danger">{pairing.error}</p>}</div>}
    {machine.status === 'incompatible' && <p className="mt-3 text-xs text-warning">Update Ari on the host before pairing or sending commands.</p>}
    {(failure ?? machine.error) && <p role="alert" className="mt-3 text-xs text-danger">{failure ?? (typeof machine.error === 'string' ? machine.error : messageOf(machine.error))}</p>}
    {removing && <div role="alertdialog" aria-label={`Remove ${machine.name}`} className="mt-3 rounded-md border border-danger/40 p-3"><p className="text-sm">Remove this computer and its saved pairing?</p><div className="mt-3 flex gap-2"><Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => rpc.invoke('machines.remove', { machineId: machine.id }))}>Remove computer</Button><Button size="sm" onClick={() => setRemoving(false)}>Cancel</Button></div></div>}
  </article>
}
