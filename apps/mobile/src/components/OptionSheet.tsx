import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { BottomSheet } from './ui'

export interface SheetOption<T extends string> {
  value: T
  label: string
  description?: string
}

/** A short single-choice list: what each option means, and which one is in effect. */
export function OptionSheet<T extends string>({
  title,
  options,
  selected,
  note,
  onSelect,
  onClose,
}: {
  title: string
  options: readonly SheetOption<T>[]
  selected: T | null
  note?: string
  onSelect: (value: T) => void
  onClose: () => void
}): ReactNode {
  return (
    <BottomSheet title={title} onClose={onClose}>
      <ul className="pb-2">
        {options.map((option) => (
          <li key={option.value}>
            <button
              type="button"
              aria-pressed={option.value === selected}
              className="flex min-h-14 w-full items-center gap-3 rounded-xl px-1 py-2.5 text-left active:bg-surface-1"
              onClick={() => {
                onSelect(option.value)
                onClose()
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium">{option.label}</span>
                {option.description !== undefined && (
                  <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">
                    {option.description}
                  </span>
                )}
              </span>
              {option.value === selected && <Check size={17} className="shrink-0 text-accent" />}
            </button>
          </li>
        ))}
      </ul>
      {note !== undefined && <p className="pb-2 text-xs text-fg-subtle">{note}</p>}
    </BottomSheet>
  )
}
