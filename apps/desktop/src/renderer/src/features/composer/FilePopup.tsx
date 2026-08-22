import { useEffect, useId, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { menuInVariants } from '@ari/ui/motion'

export interface FilePopupProps {
  /** Workspace paths to list, already filtered/limited by the caller. */
  items: readonly string[]
  /** Called with the chosen path on Enter or click. */
  onSelect: (path: string) => void
  /** Called when the user presses Escape. */
  onClose: () => void
}

/**
 * @file mention popup: renders the given paths as a listbox anchored above the
 * composer. Owns its keyboard behavior via a capture-phase window listener so
 * ArrowUp/ArrowDown/Enter are intercepted before they reach the composer
 * textarea; Escape closes.
 */
export function FilePopup({ items, onSelect, onClose }: FilePopupProps) {
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
          const path = state.items[state.activeIndex]
          if (path) {
            event.preventDefault()
            event.stopPropagation()
            state.onSelect(path)
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
      className="overflow-hidden rounded-md border border-border bg-surface-0 shadow-lg"
    >
      <ul role="listbox" aria-label="File mentions" className="max-h-[232px] overflow-y-auto p-1">
        {items.map((path, index) => {
          const active = index === activeIndex
          const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
          const dir = slash === -1 ? '' : path.slice(0, slash + 1)
          const base = slash === -1 ? path : path.slice(slash + 1)
          return (
            <li
              key={path}
              id={`${idBase}-option-${index}`}
              role="option"
              aria-selected={active}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => onSelect(path)}
              className={[
                'flex h-8 cursor-default select-none items-center gap-1 rounded-md px-2 font-mono text-sm',
                'focus-visible:outline-none',
                active ? 'bg-surface-2' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="shrink-0 text-accent">@</span>
              {dir && <span className="min-w-0 truncate text-fg-subtle">{dir}</span>}
              <span className="min-w-0 truncate text-fg">{base}</span>
            </li>
          )
        })}
      </ul>
    </motion.div>
  )
}
