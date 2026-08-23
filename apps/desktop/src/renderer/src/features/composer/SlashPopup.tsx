import { useEffect, useId, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { menuInVariants } from '@ari/ui/motion'
import { matchSlash } from './slash-commands'
import type { SlashCommand } from './slash-commands'

export interface SlashPopupProps {
  /** Query text to filter the registry by (with or without leading `/`). */
  query: string
  /** Called with the chosen command on Enter or click. */
  onSelect: (command: SlashCommand) => void
  /** Called when the user presses Escape. */
  onClose: () => void
}

/**
 * Slash-command popup: renders `matchSlash(query)` as a listbox anchored
 * above/inside the composer. Owns its keyboard behavior via a capture-phase
 * window listener so ArrowUp/ArrowDown/Enter are intercepted before they
 * reach the composer textarea; Escape closes.
 */
export function SlashPopup({ query, onSelect, onClose }: SlashPopupProps) {
  const items = matchSlash(query)
  const [activeIndex, setActiveIndex] = useState(0)
  const idBase = useId()

  // Keep the highlight valid as the filtered set shrinks/grows per keystroke.
  useEffect(() => {
    setActiveIndex((index) => (index < items.length ? index : 0))
  })

  const latest = useRef({ items, activeIndex, onSelect, onClose })
  latest.current = { items, activeIndex, onSelect, onClose }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = latest.current
      if (state.items.length === 0) return
      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault()
          event.stopPropagation()
          setActiveIndex((index) => (index + 1) % state.items.length)
          break
        }
        case 'ArrowUp': {
          event.preventDefault()
          event.stopPropagation()
          setActiveIndex((index) => (index - 1 + state.items.length) % state.items.length)
          break
        }
        case 'Enter': {
          const command = state.items[state.activeIndex]
          if (command) {
            event.preventDefault()
            event.stopPropagation()
            state.onSelect(command)
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
  }, [])

  if (items.length === 0) return null

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={menuInVariants}
      className="ari-glass-overlay overflow-hidden rounded-md border border-border shadow-lg"
    >
      <ul role="listbox" aria-label="Slash commands" className="p-1">
        {items.map((command, index) => {
          const active = index === activeIndex
          return (
            <li
              key={command.name}
              id={`${idBase}-option-${command.name}`}
              role="option"
              aria-selected={active}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => onSelect(command)}
              className={[
                'flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm',
                'focus-visible:outline-none',
                active ? 'bg-surface-2' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="shrink-0 font-mono text-accent">/{command.name}</span>
              {command.argsHint && (
                <span className="shrink-0 font-mono text-xs text-fg-subtle">{command.argsHint}</span>
              )}
              <span className="min-w-0 flex-1 truncate text-right text-fg-muted">
                {command.description}
              </span>
            </li>
          )
        })}
      </ul>
    </motion.div>
  )
}
