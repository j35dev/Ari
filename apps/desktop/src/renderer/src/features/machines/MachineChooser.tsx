import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Monitor, X } from 'lucide-react'
import { layerRoot } from '@ari/ui/layer-root'
import { useOverlayRef } from '@ari/ui/overlay-registry'
import type { MachineView } from '@ari/contracts/machines'
import { machineCan } from './use-machines'

export function MachineChooser({ machines, onChoose, onClose }: {
  machines: MachineView[]
  onChoose: (machineId: string | null) => void
  onClose: () => void
}) {
  const overlay = useOverlayRef()
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  return createPortal(<div ref={overlay} className="fixed inset-0 z-overlay flex items-start justify-center bg-black/40 pt-[12vh]" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="Choose computer for new session" className="w-[min(440px,90vw)] rounded-lg border border-border bg-surface-2 p-3 shadow-lg" onClick={(event) => event.stopPropagation()}>
      <header className="mb-2 flex items-center justify-between px-2 py-1"><h2 className="text-sm font-medium">Where should this session run?</h2><button type="button" aria-label="Close computer chooser" onClick={onClose}><X size={15} /></button></header>
      <button type="button" autoFocus onClick={() => onChoose(null)} className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-accent-ring"><Monitor size={18} /><span>This computer<span className="block text-xs text-fg-subtle">Local projects and providers</span></span></button>
      {machines.map((machine) => <button type="button" key={machine.id} disabled={!machineCan(machine, 'session.create')} onClick={() => onChoose(machine.id)} className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40"><Monitor size={18} /><span className="min-w-0"><span className="block truncate">{machine.name}</span><span className="block text-xs text-fg-subtle">{machine.status} · Host projects and providers</span></span></button>)}
      <p className="px-3 pb-1 pt-3 text-xs text-fg-muted">The selected computer owns the workspace and runs the agent.</p>
    </section>
  </div>, layerRoot())
}
