import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Laptop, Plus } from 'lucide-react'
import { BottomSheet } from '../../components/ui'
import { useApp } from '../../lib/app-state'
import { computerName } from '../../lib/computers'
import { IS_CONNECT_BUILD } from '../../lib/connect'
import { connectionLabel, relativeTime } from '../../lib/format'

/** The active computer is visible where sessions are chosen, not only in settings. */
export function ComputerButton(): ReactNode {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const name = app.activeComputer?.name ?? (app.origin === null ? 'Choose computer' : computerName(app.origin))
  return <>
    <button type="button" className="computer-button" aria-label={`Switch computer: ${name}`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <Laptop size={17} aria-hidden className="shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1 truncate text-left">{name}</span>
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${app.connection === 'connected' ? 'bg-success' : 'bg-warning'}`} />
      <ChevronDown size={13} aria-hidden className="shrink-0 text-fg-subtle" />
    </button>
    {open && <ComputerSwitcher onClose={() => setOpen(false)} />}
  </>
}

/** A private switch navigates to the destination PWA; phone keys never leave their origin. */
export function ComputerSwitcher({ onClose }: { onClose: () => void }): ReactNode {
  const app = useApp()
  const [adding, setAdding] = useState(false)
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  function select(origin: string): void {
    try { app.switchComputer(origin); onClose() }
    catch (error) { setFailure(error instanceof Error ? error.message : 'Could not open this computer.') }
  }
  return <BottomSheet title="Computers" onClose={onClose}>
    <p className="mb-3 text-xs leading-relaxed text-fg-muted">
      Each computer keeps its own sessions, drafts and phone access.
    </p>
    <ul className="divide-y divide-border">
      {(app.computers ?? []).map((computer) => {
        const selected = computer.origin === app.origin
        return <li key={computer.origin}>
          <button type="button" className="flex min-h-20 w-full items-center gap-3 py-3 text-left" aria-label={`Open computer: ${computer.name}`} onClick={() => select(computer.origin)}>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2"><Laptop size={18} className="text-fg-muted" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{computer.name}</span>
              <span className="mt-0.5 block break-all text-[11px] leading-relaxed text-fg-subtle">{new URL(computer.origin).host}</span>
              <span className="mt-1 block text-xs text-fg-muted">{selected ? connectionLabel(app.connection) : computer.lastConnectedAt === null ? 'Open to connect' : `Last connected ${relativeTime(computer.lastConnectedAt)}`}</span>
            </span>
            {selected ? <Check size={17} className="shrink-0 text-accent" aria-label="Selected computer" /> : <ChevronRight size={16} className="shrink-0 text-fg-subtle" />}
          </button>
        </li>
      })}
    </ul>
    {IS_CONNECT_BUILD ? <button type="button" className="secondary-button mt-3 w-full" onClick={app.changeComputer}>Choose from Ari Connect</button>
      : adding ? <form className="mt-4 space-y-3 border-t border-border pt-4" onSubmit={(event) => {
        event.preventDefault()
        try { app.addComputer(address, name); onClose() }
        catch (error) { setFailure(error instanceof Error ? error.message : 'Check this computer’s address.') }
      }}>
        <label className="block text-xs text-fg-muted" htmlFor="computer-address">Tailscale address or pairing link</label>
        <input id="computer-address" type="url" value={address} onChange={(event) => setAddress(event.target.value)} autoCapitalize="none" autoCorrect="off" autoComplete="off" placeholder="https://computer.tailnet.ts.net:8443" required className="computer-field" />
        <label className="block text-xs text-fg-muted" htmlFor="computer-label">Name (optional)</label>
        <input id="computer-label" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Studio" className="computer-field" />
        <p className="text-xs leading-relaxed text-fg-muted">Ari opens at this computer’s address. Pair this phone there if it has not been approved yet.</p>
        <button type="submit" className="primary-button w-full">Open computer</button>
      </form> : <button type="button" className="secondary-button mt-4 w-full gap-2" onClick={() => setAdding(true)}><Plus size={16} />Add computer</button>}
    {failure !== null && <p role="alert" className="error-banner">{failure}</p>}
  </BottomSheet>
}
