import { useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Popover } from '@ari/ui/popover'
import { cx, textButton } from '../../lib/recipes'

/** The composer's pickers read as text until hovered: no border, no tile. */
export const PICKER = cx(textButton, 'shrink-0 whitespace-nowrap')

/** Agents name their modes and levels in lowercase ("plan"); a menu reads them as sentences. */
export function sentenceCase(label: string): string {
  return label === label.toLowerCase() ? label.charAt(0).toUpperCase() + label.slice(1) : label
}

/**
 * One choice in a picker's menu. With a hint it is two lines: the value, then
 * what choosing it means, in full, so nothing is cut off mid-sentence. A mark
 * says at a glance what kind of choice it is; a check marks the current one.
 */
export function PickerOption({
  label,
  hint,
  mark,
  selected,
  disabled = false,
  role = 'option',
  title,
  onSelect,
}: {
  label: string
  hint?: string
  /** A 15px glyph drawn in the row's ink: an icon, or the effort bars. */
  mark?: ReactNode
  selected: boolean
  disabled?: boolean
  /** A listbox choice, or an action in a menu. */
  role?: 'option' | 'menuitem'
  title?: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role={role}
      aria-selected={role === 'option' ? selected : undefined}
      disabled={disabled}
      title={title}
      onClick={onSelect}
      className={cx(
        'flex w-full min-w-0 gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors hover:bg-fg/6 focus-visible:bg-fg/6 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45',
        hint ? 'items-start py-2' : 'h-8 items-center',
      )}
    >
      {mark !== undefined ? (
        <span
          className={cx('flex shrink-0', hint && 'mt-px', selected ? 'text-fg' : 'text-fg-subtle')}
        >
          {mark}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className={cx('block truncate text-fg', selected && 'font-medium')}>{label}</span>
        {hint ? (
          <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-fg-subtle">
            {hint}
          </span>
        ) : null}
      </span>
      {/* Always laid out, so the text column is the same width on every row. */}
      <Check
        size={14}
        aria-hidden
        className={cx('shrink-0 text-fg', hint && 'mt-0.5', !selected && 'invisible')}
      />
    </button>
  )
}

export interface TextPickerOption {
  value: string
  label: string
  hint?: string
  /** Shown on hover only, for a description not worth a second line. */
  title?: string
  mark?: ReactNode
}

/**
 * A composer-row choice that reads as text: the current value and a chevron,
 * opening a menu of {@link PickerOption}s. For choices whose options the
 * caller already holds; the model, effort and permission chips load their own.
 */
export function TextPicker({
  label,
  value,
  options,
  onChange,
  disabled = false,
  title,
  mark,
  placeholder = 'Choose',
  menuClassName,
}: {
  /** The trigger's accessible name, and the menu's. */
  label: string
  value: string
  options: readonly TextPickerOption[]
  onChange: (value: string) => void
  disabled?: boolean
  title?: string
  /** A glyph before the value on the trigger. */
  mark?: ReactNode
  placeholder?: string
  menuClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const current = options.find((option) => option.value === value)
  const described = options.some((option) => option.hint)
  return (
    <div ref={setAnchor} className="relative min-w-0">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={title ?? current?.hint}
        onClick={() => setOpen((next) => !next)}
        className={cx(PICKER, 'max-w-full')}
      >
        {mark !== undefined ? <span className="flex shrink-0 text-fg-subtle">{mark}</span> : null}
        <span className="min-w-0 truncate">{current?.label ?? placeholder}</span>
        <ChevronDown
          size={12}
          aria-hidden
          className={cx(
            '-ms-0.5 shrink-0 text-fg-subtle transition-transform duration-[var(--ari-dur-fast)]',
            open && 'rotate-180',
          )}
        />
      </button>
      <Popover open={open && !disabled} onOpenChange={setOpen} anchor={anchor}>
        <Popover.Content
          side="top"
          align="start"
          role="listbox"
          aria-label={label}
          // A long list scrolls inside the menu instead of running off the window.
          className={cx(
            menuClassName ?? (described ? 'w-80' : 'w-56'),
            'ari-scroll max-h-[min(22rem,60vh)] overflow-y-auto',
          )}
        >
          {options.map((option) => (
            <PickerOption
              key={option.value}
              label={option.label}
              hint={option.hint}
              title={option.title}
              mark={option.mark}
              selected={option.value === value}
              onSelect={() => {
                onChange(option.value)
                setOpen(false)
              }}
            />
          ))}
        </Popover.Content>
      </Popover>
    </div>
  )
}
