import { useState } from 'react'
import { Check, ChevronDown, Monitor, Sparkles } from 'lucide-react'
import { Popover } from '@ari/ui/popover'
import { manualEligibility, type SelectionHost } from './machine-policy'

export interface DraftMachineSelection {
  mode: 'manual' | 'auto'
  hostId: string | null
  reason: string
}

export function MachinePicker({ hosts, selection, locked, onSelect }: {
  hosts: SelectionHost[]
  selection: DraftMachineSelection
  locked: boolean
  onSelect: (hostId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const selected = hosts.find((host) => host.id === selection.hostId)
  const choose = (id: string) => { onSelect(id); setOpen(false) }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" ref={setAnchor}>
      <button type="button" aria-label="Execution machine" aria-haspopup="menu" aria-expanded={open}
        disabled={locked} onClick={() => setOpen((value) => !value)}
        title={locked ? 'This draft is fixed to its machine after choosing a workspace or sending.' : selection.reason}
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-60">
        {selection.mode === 'auto' ? <Sparkles size={13} /> : <Monitor size={13} />}
        {selection.mode === 'auto' ? `Auto${selected ? ` · ${selected.name}` : ''}` : selected?.name ?? 'Select machine'}
        <ChevronDown size={11} />
      </button>
      <span className="text-fg-subtle" role="status">{selection.reason}</span>
      <Popover open={open && !locked} onOpenChange={setOpen} anchor={anchor}>
        <Popover.Content side="top" align="start" role="menu" aria-label="Execution machines" className="w-80 p-1">
          <button type="button" role="menuitem" onClick={() => choose('auto')}
            className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-surface-2">
            <Sparkles size={14} /><span className="flex-1">Auto<span className="block text-xs text-fg-subtle">Choose once using fresh machine resources</span></span>
            {selection.mode === 'auto' && <Check size={13} />}
          </button>
          {hosts.map((host) => {
            const reason = manualEligibility(host)
            return <button key={host.id} type="button" role="menuitem" disabled={reason !== null}
              title={reason ?? host.name} onClick={() => choose(host.id)}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-45">
              <Monitor size={14} /><span className="min-w-0 flex-1"><span className="block truncate">{host.name}</span>
                {reason && <span className="block text-xs text-fg-subtle">{reason}</span>}</span>
              {selection.mode === 'manual' && selection.hostId === host.id && <Check size={13} />}
            </button>
          })}
        </Popover.Content>
      </Popover>
    </div>
  )
}
