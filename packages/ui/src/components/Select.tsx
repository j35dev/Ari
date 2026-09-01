import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Popover } from './Popover'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps {
  /** Controlled selected value; provide together with onValueChange. */
  value?: string
  /** Initially selected value for uncontrolled usage. */
  defaultValue?: string
  /** Called with the newly selected option value. */
  onValueChange?: (value: string) => void
  /** Options to render in the listbox. */
  options: SelectOption[]
  /** Shown on the trigger while no option is selected. */
  placeholder?: string
  /** Disables the trigger. */
  disabled?: boolean
  className?: string
}

/** Index of the first non-disabled option, or -1. */
function firstEnabledIndex(options: SelectOption[]): number {
  return options.findIndex((option) => !option.disabled)
}

/** Index of the last non-disabled option, or -1. */
function lastEnabledIndex(options: SelectOption[]): number {
  for (let i = options.length - 1; i >= 0; i--) {
    if (!options[i]?.disabled) return i
  }
  return -1
}

/** Nearest enabled index stepping `delta` from `start`, wrapping once around the list. */
function nextEnabledIndex(options: SelectOption[], start: number, delta: 1 | -1): number {
  const count = options.length
  for (let i = 1; i <= count; i++) {
    const index = (((start + delta * i) % count) + count) % count
    if (!options[index]?.disabled) return index
  }
  return -1
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-subtle">
      <path
        d="M4 6l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className={['h-3 w-3 shrink-0 text-fg', className].filter(Boolean).join(' ')}
    >
      <path
        d="M2.5 6.5 5 9l4.5-5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

interface SelectListboxProps {
  options: SelectOption[]
  selectedValue?: string
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (option: SelectOption) => void
}

/**
 * Focusable listbox using aria-activedescendant; receives focus when the
 * popover opens and owns all listbox keyboard behavior.
 */
function SelectListbox({
  options,
  selectedValue,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: SelectListboxProps) {
  const idBase = useId().replace(/\W/g, '')
  const listRef = useRef<HTMLDivElement | null>(null)
  const typeaheadRef = useRef({ char: '', at: 0 })

  useEffect(() => {
    listRef.current?.focus()
  }, [])

  // Keep the highlighted option visible without stealing scroll position.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active]')
    active?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault()
        const start = activeIndex < 0 ? firstEnabledIndex(options) : activeIndex
        onActiveIndexChange(nextEnabledIndex(options, start, 1))
        break
      }
      case 'ArrowUp': {
        event.preventDefault()
        const start = activeIndex < 0 ? lastEnabledIndex(options) : activeIndex
        onActiveIndexChange(nextEnabledIndex(options, start, -1))
        break
      }
      case 'Home':
        event.preventDefault()
        onActiveIndexChange(firstEnabledIndex(options))
        break
      case 'End':
        event.preventDefault()
        onActiveIndexChange(lastEnabledIndex(options))
        break
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const option = options[activeIndex]
        if (option && !option.disabled) onSelect(option)
        break
      }
      default: {
        // Typeahead: jump to (or cycle through) options starting with the typed letter.
        const char = event.key.toLowerCase()
        if (char.length !== 1 || char === ' ') return
        event.preventDefault()
        const now = Date.now()
        const repeat = typeaheadRef.current.char === char && now - typeaheadRef.current.at < 500
        typeaheadRef.current = { char, at: now }
        const start = repeat ? activeIndex : -1
        const count = options.length
        for (let i = 1; i <= count; i++) {
          const index = (((start + i) % count) + count) % count
          const option = options[index]
          if (option && !option.disabled && option.label.toLowerCase().startsWith(char)) {
            onActiveIndexChange(index)
            return
          }
        }
      }
    }
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      tabIndex={-1}
      aria-activedescendant={
        activeIndex >= 0 ? `${idBase}-option-${options[activeIndex]?.value}` : undefined
      }
      onKeyDown={handleKeyDown}
      className="ari-scroll max-h-72 overflow-y-auto overscroll-contain focus-visible:outline-none"
    >
      {options.map((option, index) => {
        const selected = option.value === selectedValue
        const active = index === activeIndex
        return (
          <div
            key={option.value}
            id={`${idBase}-option-${option.value}`}
            role="option"
            aria-selected={selected}
            aria-disabled={option.disabled || undefined}
            data-active={active ? '' : undefined}
            onMouseMove={() => {
              if (!option.disabled) onActiveIndexChange(index)
            }}
            onClick={() => {
              if (!option.disabled) onSelect(option)
            }}
            className={[
              'flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm',
              'focus-visible:outline-none',
              option.disabled ? 'opacity-50' : '',
              active ? 'bg-surface-2' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {selected && <CheckIcon />}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Listbox select built on the Popover primitive. The trigger is styled like an
 * input and shows the selected label or the placeholder; the panel is a
 * keyboard-navigable listbox (arrows/Home/End move, Enter/Space commit,
 * Escape closes via Popover, printable keys typeahead).
 */
export function Select({
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder,
  disabled = false,
  className,
}: SelectProps): ReactNode {
  const [internal, setInternal] = useState(defaultValue)
  const isControlled = value !== undefined
  const current = isControlled ? value : internal
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)

  const selected = options.find((option) => option.value === current)

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      const selectedIndex = options.findIndex(
        (option) => option.value === current && !option.disabled,
      )
      setActiveIndex(selectedIndex !== -1 ? selectedIndex : firstEnabledIndex(options))
    }
  }

  const handleSelect = (option: SelectOption) => {
    if (!isControlled) setInternal(option.value)
    onValueChange?.(option.value)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        disabled={disabled}
        className={[
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-1 px-3 text-sm',
          'transition-shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <span className="min-w-0 truncate text-fg-subtle">
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDownIcon />
      </Popover.Trigger>
      <Popover.Content side="bottom" align="start">
        <SelectListbox
          options={options}
          selectedValue={current}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          onSelect={handleSelect}
        />
      </Popover.Content>
    </Popover>
  )
}
