import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Columns2, LayoutGrid, PanelLeft } from 'lucide-react'
import { Popover } from '@ari/ui/popover'
import type { TerminalDeskPreset } from './terminal-workspace-state'

const LAYOUTS = [
  {
    value: 'desk',
    label: 'Terminal desk',
    description: 'Full-width terminals. Minimal chrome.',
    icon: Columns2,
  },
  {
    value: 'agents',
    label: 'Agent desk',
    description: 'Projects and terminal tabs in a sidebar.',
    icon: PanelLeft,
  },
  {
    value: 'workbench',
    label: 'Workbench',
    description: 'Terminals with files and changes beside them.',
    icon: LayoutGrid,
  },
] as const

export function TerminalLayoutPicker({
  value,
  onChange,
}: {
  value: TerminalDeskPreset
  onChange: (value: TerminalDeskPreset) => void
}) {
  const [open, setOpen] = useState(false)
  const options = useRef<(HTMLButtonElement | null)[]>([])
  const selected = LAYOUTS.find((layout) => layout.value === value) ?? LAYOUTS[0]
  const Icon = selected.icon

  useEffect(() => {
    if (open) options.current[LAYOUTS.findIndex((layout) => layout.value === value)]?.focus()
  }, [open, value])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="ari-terminal-layout-trigger"
        aria-label="Terminal desk layout"
        aria-haspopup="menu"
        title="Choose workspace layout"
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <Icon size={13} strokeWidth={1.6} aria-hidden />
        <span>{selected.label}</span>
        <ChevronDown size={11} aria-hidden className={open ? 'is-open' : undefined} />
      </Popover.Trigger>
      <Popover.Content
        side="bottom"
        align="start"
        sideOffset={6}
        role="menu"
        aria-label="Workspace layouts"
        className="ari-terminal-layout-menu"
        onKeyDown={(event) => {
          const index = options.current.findIndex((option) => option === document.activeElement)
          let next: number | undefined
          if (event.key === 'ArrowDown') next = (index + 1) % LAYOUTS.length
          if (event.key === 'ArrowUp') next = (index - 1 + LAYOUTS.length) % LAYOUTS.length
          if (event.key === 'Home') next = 0
          if (event.key === 'End') next = LAYOUTS.length - 1
          if (next !== undefined) {
            event.preventDefault()
            event.stopPropagation()
            options.current[next]?.focus()
          }
        }}
      >
        <div className="ari-terminal-layout-menu-label">Workspace layout</div>
        {LAYOUTS.map((layout, index) => (
          <button
            key={layout.value}
            ref={(element) => {
              options.current[index] = element
            }}
            type="button"
            role="menuitemradio"
            aria-checked={value === layout.value}
            className="ari-terminal-layout-option"
            onClick={() => {
              onChange(layout.value)
              setOpen(false)
            }}
          >
            <span className="ari-terminal-layout-preview" data-layout={layout.value} aria-hidden>
              <span className="preview-sidebar" />
              <span className="preview-terminal" />
              <span className="preview-terminal" />
              <span className="preview-panel" />
            </span>
            <span className="ari-terminal-layout-copy">
              <strong>{layout.label}</strong>
              <span>{layout.description}</span>
            </span>
            <Check
              size={13}
              aria-hidden
              className={value === layout.value ? 'layout-check' : 'layout-check is-hidden'}
            />
          </button>
        ))}
      </Popover.Content>
    </Popover>
  )
}
