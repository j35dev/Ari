import { useEffect, useId, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { SlashCommand, SlashCommandSource } from '@ari/contracts/slash-commands'
import { menuInVariants } from '@ari/ui/motion'
import { cx } from '../../lib/recipes'

export interface SlashPopupProps {
  /** Commands to list, already filtered and ordered by the caller. */
  items: readonly SlashCommand[]
  /** Called with the chosen command on Enter, Tab or click. Never with a disabled one. */
  onSelect: (command: SlashCommand) => void
  /** Called when the user presses Escape. */
  onClose: () => void
  /** A line under the list: the provider's commands are still loading, or partial. */
  note?: string | null
}

const SOURCE_LABELS: Record<SlashCommandSource, string> = {
  ari: 'Ari',
  builtin: 'Built-in',
  project: 'Project',
  user: 'User',
  skill: 'Skill',
  mcp: 'MCP',
}

/**
 * "/" command menu, the twin of {@link FilePopup}: a listbox anchored above
 * the composer that keeps the composer's width, so it never leaves a narrow
 * split pane, and scrolls past a capped height. Keyboard handling rides a
 * capture-phase window listener so the arrows, Enter and Tab reach it before
 * the textarea. Commands Ari cannot run stay listed, dimmed, with the reason
 * shown while highlighted; choosing one does nothing. Choosing never runs a
 * command either: the caller only inserts it.
 */
export function SlashPopup({ items, onSelect, onClose, note }: SlashPopupProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const idBase = useId()
  const listRef = useRef<HTMLUListElement>(null)

  // Keep the highlight valid as the filtered set shrinks/grows per keystroke.
  useEffect(() => {
    setActiveIndex((index) => (index < items.length ? index : 0))
  })

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

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
        case 'Tab':
        case 'Enter': {
          if (event.shiftKey || event.isComposing) break
          const command = state.items[state.activeIndex]
          if (!command) break
          // Swallowed either way: Enter on a disabled row must not send the draft.
          event.preventDefault()
          event.stopPropagation()
          if (command.run !== 'unsupported') state.onSelect(command)
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

  if (items.length === 0 && !note) return null
  const active = items[activeIndex]

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={menuInVariants}
      className="@container overflow-hidden rounded-xl border border-border-strong bg-surface-1 shadow-3"
    >
      {items.length > 0 && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Slash commands"
          aria-activedescendant={`${idBase}-option-${activeIndex}`}
          className="ari-scroll max-h-[264px] overflow-y-auto p-1"
        >
          {items.map((command, index) => {
            const highlighted = index === activeIndex
            const disabled = command.run === 'unsupported'
            return (
              <li
                key={command.name}
                id={`${idBase}-option-${index}`}
                data-index={index}
                role="option"
                aria-selected={highlighted}
                aria-disabled={disabled || undefined}
                title={disabled ? command.reason : command.description || undefined}
                onMouseMove={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!disabled) onSelect(command)
                }}
                className={cx(
                  'flex h-8 min-w-0 cursor-default select-none items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors',
                  highlighted && 'bg-fg/6',
                  disabled && 'opacity-55',
                )}
              >
                <span className="shrink-0 text-fg">/{command.name}</span>
                {command.argumentHint && (
                  <span className="hidden shrink-0 text-xs text-fg-subtle @[22rem]:inline">
                    {command.argumentHint}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">
                  {command.description}
                </span>
                <span className="shrink-0 rounded px-1.5 py-px text-[11px] leading-4 text-fg-subtle ring-1 ring-border">
                  {SOURCE_LABELS[command.source]}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {active?.run === 'unsupported' && active.reason ? (
        <p role="status" className="border-t border-border px-3 py-1.5 text-xs text-fg-muted">
          {active.reason}
        </p>
      ) : note ? (
        <p className="border-t border-border px-3 py-1.5 text-xs text-fg-subtle first:border-t-0">
          {note}
        </p>
      ) : null}
    </motion.div>
  )
}
