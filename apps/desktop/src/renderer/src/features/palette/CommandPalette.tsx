import { useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Search } from 'lucide-react'
import { menuInVariants } from '@ari/ui/motion'
import { Kbd } from '@ari/ui/kbd'
import { matchCommands } from './match'
import type { PaletteCommand } from './useCommands'

export interface CommandPaletteProps {
  /** Whether the overlay is currently shown. */
  open: boolean
  /** Called on Escape, backdrop click, or after a command runs. */
  onClose: () => void
  /** The action registry to search and run. */
  commands: readonly PaletteCommand[]
}

/**
 * Global command palette (M2.7): centered overlay with a fuzzy-filtered
 * command list. Owns its keyboard behavior via a capture-phase window
 * listener — ArrowUp/ArrowDown cycle the highlight, Enter runs the active
 * command, Escape closes.
 */
export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const idBase = useId()

  const results = open ? matchCommands(commands, query) : []

  // Fresh query and highlight every time the palette opens; focus the input.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      inputRef.current?.focus()
    }
  }, [open])

  // Keep the highlight valid as the filtered set shrinks/grows per keystroke.
  useEffect(() => {
    setActiveIndex((index) => (index < results.length ? index : 0))
  })

  // Keep the highlighted row visible inside the scrolling results list.
  useEffect(() => {
    listRef.current?.children[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const latest = useRef({ results, activeIndex, onClose })
  latest.current = { results, activeIndex, onClose }

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      const state = latest.current
      switch (event.key) {
        case 'ArrowDown': {
          if (state.results.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          setActiveIndex((index) => (index + 1) % state.results.length)
          break
        }
        case 'ArrowUp': {
          if (state.results.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          setActiveIndex((index) => (index - 1 + state.results.length) % state.results.length)
          break
        }
        case 'Enter': {
          const command = state.results[state.activeIndex]
          if (command) {
            event.preventDefault()
            event.stopPropagation()
            state.onClose()
            command.run()
          }
          break
        }
        case 'Escape': {
          event.stopPropagation()
          state.onClose()
          break
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  return (
    <AnimatePresence>
      {open ? (
        <div
          key="palette"
          onClick={() => onClose()}
          className="fixed inset-0 z-50 flex justify-center"
          style={{ background: 'color-mix(in oklab, black 45%, transparent)' }}
        >
          <motion.div
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={menuInVariants}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onClick={(event) => event.stopPropagation()}
            className="mt-[12vh] h-fit w-[min(560px,90vw)] overflow-hidden rounded-lg border border-border ari-glass-overlay"
            style={{ boxShadow: 'var(--ari-shadow-3)' }}
          >
            <div className="flex h-12 items-center gap-2 border-b border-border px-4">
              <Search size={16} strokeWidth={1.8} className="shrink-0 text-fg-subtle" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Type a command…"
                aria-label="Search commands"
                spellCheck={false}
                className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
              />
            </div>
            <ul
              ref={listRef}
              role="listbox"
              aria-label="Commands"
              className="ari-scroll max-h-80 overflow-auto p-1"
            >
              {results.map((command, index) => {
                const active = index === activeIndex
                const Icon = command.icon
                return (
                  <li
                    key={command.id}
                    id={`${idBase}-option-${command.id}`}
                    role="option"
                    aria-selected={active}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => {
                      onClose()
                      command.run()
                    }}
                    className={[
                      'flex h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2',
                      'focus-visible:outline-none',
                      active ? 'bg-surface-2' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {Icon ? (
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-fg-muted">
                        <Icon size={16} strokeWidth={1.8} />
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">
                      {command.label}
                    </span>
                    {command.hint ? <Kbd>{command.hint}</Kbd> : null}
                  </li>
                )
              })}
              {results.length === 0 ? (
                <li className="flex h-9 items-center px-2 text-sm text-fg-subtle">
                  No matching commands
                </li>
              ) : null}
            </ul>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  )
}
