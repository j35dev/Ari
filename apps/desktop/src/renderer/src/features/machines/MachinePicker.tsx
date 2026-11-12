import { useState } from 'react'
import { ChevronDown, Monitor, Sparkles } from 'lucide-react'
import { Popover } from '@ari/ui/popover'
import { cx } from '../../lib/recipes'
import { PICKER, PickerOption } from '../session/TextPicker'
import { manualEligibility, type SelectionHost } from './machine-policy'

export interface DraftMachineSelection {
  mode: 'manual' | 'auto'
  hostId: string | null
  reason: string
}

const MACHINE_MARK = <Monitor size={15} strokeWidth={1.7} aria-hidden />
const AUTO_MARK = <Sparkles size={15} strokeWidth={1.7} aria-hidden />

/**
 * Which computer runs a new draft, as the first of the pickers under the
 * composer. Auto picks once from fresh resource data; a machine that cannot
 * take the draft stays listed, disabled, with the reason as its hint.
 */
export function MachinePicker({
  hosts,
  selection,
  locked,
  onSelect,
  children,
}: {
  hosts: SelectionHost[]
  selection: DraftMachineSelection
  locked: boolean
  onSelect: (hostId: string) => void
  /** Pickers that belong on the same line, such as the checkout and workspace. */
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const selected = hosts.find((host) => host.id === selection.hostId)
  const choose = (id: string) => {
    onSelect(id)
    setOpen(false)
  }
  return (
    <div className="-ml-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5" ref={setAnchor}>
      <button
        type="button"
        aria-label="Execution machine"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={locked}
        onClick={() => setOpen((value) => !value)}
        title={
          locked
            ? 'This draft is fixed to its machine after choosing a workspace or sending.'
            : selection.reason
        }
        className={PICKER}
      >
        <span className="flex shrink-0 text-fg-subtle">
          {selection.mode === 'auto' ? AUTO_MARK : MACHINE_MARK}
        </span>
        <span className="truncate">
          {selection.mode === 'auto'
            ? `Auto${selected ? ` · ${selected.name}` : ''}`
            : (selected?.name ?? 'Select machine')}
        </span>
        <ChevronDown
          size={12}
          aria-hidden
          className={cx(
            '-ms-0.5 shrink-0 text-fg-subtle transition-transform duration-[var(--ari-dur-fast)]',
            open && 'rotate-180',
          )}
        />
      </button>
      {children}
      <span className="min-w-0 truncate pl-1 text-xs text-fg-subtle" role="status">
        {selection.reason}
      </span>
      <Popover open={open && !locked} onOpenChange={setOpen} anchor={anchor}>
        <Popover.Content
          side="top"
          align="start"
          role="menu"
          aria-label="Execution machines"
          className="w-72 overflow-hidden"
        >
          <PickerOption
            role="menuitem"
            label="Auto"
            hint="Choose once using fresh machine resources"
            mark={AUTO_MARK}
            selected={selection.mode === 'auto'}
            onSelect={() => choose('auto')}
          />
          {hosts.map((host) => {
            const reason = manualEligibility(host)
            return (
              <PickerOption
                key={host.id}
                role="menuitem"
                label={host.name}
                hint={reason ?? undefined}
                title={reason ?? host.name}
                mark={MACHINE_MARK}
                disabled={reason !== null}
                selected={selection.mode === 'manual' && selection.hostId === host.id}
                onSelect={() => choose(host.id)}
              />
            )
          })}
        </Popover.Content>
      </Popover>
    </div>
  )
}
