import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Search } from 'lucide-react'
import { menuInVariants } from '@ari/ui/motion'
import { layerRoot } from '@ari/ui/layer-root'
import { useOverlayRef } from '@ari/ui/overlay-registry'
import { cx } from '../../lib/recipes'
import { matchCommands } from './match'
import type { PaletteCommand } from './useCommands'

/**
 * The floating surface the palette and project search share: one rounded
 * object, centred, above a scrim. See docs/design/ari-design-language.md.
 */
export const PALETTE_SURFACE_CLASS =
  'mx-4 mt-[12vh] flex h-fit w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface-1 shadow-3'

/** 48px input row: icon, bare input, and a hairline under it. */
export const PALETTE_INPUT_ROW_CLASS =
  'flex h-12 shrink-0 items-center gap-3 border-b border-border px-4'

/** The input has no box of its own; the surface is its box. */
export const PALETTE_INPUT_CLASS =
  'h-full min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-subtle disabled:cursor-not-allowed'

/** 36px result row. Hover and the keyboard highlight are the same wash. */
export const PALETTE_ROW_CLASS =
  'flex h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-[13.5px] text-fg transition-colors hover:bg-fg/6 focus-visible:outline-none'

export const PALETTE_ROW_ACTIVE_CLASS = 'bg-fg/6'

/** A shortcut at the right of a row: quiet mono text, not a chip. */
export const PALETTE_SHORTCUT_CLASS = 'shrink-0 font-mono text-[11px] text-fg-subtle'

/** The line shown in place of results. */
export const PALETTE_EMPTY_CLASS = 'flex h-9 items-center px-2.5 text-[13.5px] text-fg-subtle'

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
  const overlayRef = useOverlayRef()
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

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div
          key="palette"
          ref={overlayRef}
          onClick={() => onClose()}
          className="fixed inset-0 z-overlay flex justify-center"
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
            className={PALETTE_SURFACE_CLASS}
          >
            <div className={PALETTE_INPUT_ROW_CLASS}>
              <Search
                size={16}
                strokeWidth={1.7}
                className="shrink-0 text-fg-subtle"
                aria-hidden="true"
              />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Type a command…"
                aria-label="Search commands"
                spellCheck={false}
                className={PALETTE_INPUT_CLASS}
              />
            </div>
            <ul
              ref={listRef}
              role="listbox"
              aria-label="Commands"
              className="ari-scroll max-h-[360px] overflow-auto p-1.5"
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
                    className={cx(PALETTE_ROW_CLASS, active && PALETTE_ROW_ACTIVE_CLASS)}
                  >
                    {Icon ? (
                      <span
                        className={cx(
                          'flex size-4 shrink-0 items-center justify-center',
                          active ? 'text-fg-muted' : 'text-fg-subtle',
                        )}
                      >
                        <Icon size={16} strokeWidth={1.7} />
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.hint ? (
                      <kbd className={PALETTE_SHORTCUT_CLASS}>{command.hint}</kbd>
                    ) : null}
                  </li>
                )
              })}
              {results.length === 0 ? (
                <li className={PALETTE_EMPTY_CLASS}>No matching commands</li>
              ) : null}
            </ul>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    layerRoot(),
  )
}
