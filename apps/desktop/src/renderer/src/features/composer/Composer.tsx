import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, Clock, Square } from 'lucide-react'
import { transitions } from '@ari/ui/motion'
import { activeTokenAt } from './active-token'
import type { SlashCommand } from './slash-commands'
import { matchSlash } from './slash-commands'
import { matchSuggestions } from './match-suggestions'
import { SlashPopup } from './SlashPopup'
import { FilePopup } from './FilePopup'

export interface ComposerProps {
  /** Called with the message text when the user sends. */
  onSend: (text: string) => void
  /** Called when the user presses stop during an active turn. */
  onStop?: () => void
  /** Whether a turn is currently running for the active session. */
  running?: boolean
  /** Messages waiting behind the active turn. */
  queued?: string[]
  /** Called with the chosen command name when the user commits a slash command. */
  onSlashCommand?: (name: string) => void
  /** Workspace paths offered by the @file mention popup; absent hides it. */
  suggestions?: string[]
  /** Rendered at the bottom-left of the input row (e.g. model pill). */
  leading?: React.ReactNode
  placeholder?: string
  disabled?: boolean
}

const MIN_HEIGHT = 44
const MAX_HEIGHT = 260

/**
 * Message composer: auto-growing textarea, send→stop morph while a turn is
 * running, Enter to send / Shift+Enter for newline. While the caret sits at
 * the end of a ` /command` or ` @path` token, a picker popup lists completions
 * above the input (slash commands from the registry, file paths from
 * `suggestions`).
 */
export function Composer({
  onSend,
  onStop,
  running = false,
  queued = [],
  onSlashCommand,
  suggestions,
  leading,
  placeholder = 'Ask, steer, or describe a task…',
  disabled = false,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const token = useMemo(() => activeTokenAt(text, caret), [text, caret])
  const tokenKey = token ? `${token.kind}:${token.start}:${token.raw}` : ''

  // Escape dismisses the popup until the token under the caret changes.
  useEffect(() => {
    setDismissed(false)
  }, [tokenKey])

  const slashItems = useMemo(() => (token?.kind === 'slash' ? matchSlash(token.raw) : []), [token])
  const mentionItems = useMemo(
    () =>
      token?.kind === 'mention' && suggestions
        ? matchSuggestions(suggestions, token.raw.slice(1))
        : [],
    [token, suggestions],
  )

  const syncCaret = useCallback((el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart ?? 0)
  }, [])

  const refocus = useCallback((caretIndex: number) => {
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(caretIndex, caretIndex)
    })
  }, [])

  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [])

  useEffect(resize, [text, resize])

  const send = useCallback(() => {
    const trimmed = text.trim()
    if (trimmed.length === 0 || disabled) return
    onSend(trimmed)
    setText('')
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [text, disabled, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        send()
      }
    },
    [send],
  )

  const closePopup = useCallback(() => setDismissed(true), [])

  /** Remove the `/command` token under the caret and commit the command. */
  const handleSlashSelect = useCallback(
    (command: SlashCommand) => {
      if (token?.kind !== 'slash') return
      const rest = text.slice(caret)
      const next = (text.slice(0, token.start) + rest).replace(/^\s+/, '')
      const nextCaret = next.length - rest.length
      setText(next)
      setCaret(nextCaret)
      onSlashCommand?.(command.name)
      refocus(nextCaret)
    },
    [token, text, caret, onSlashCommand, refocus],
  )

  /** Replace the `@partial` token with the chosen path plus a word break. */
  const handleMentionSelect = useCallback(
    (path: string) => {
      if (token?.kind !== 'mention') return
      const insert = `@${path} `
      const nextCaret = token.start + insert.length
      setText((prev) => prev.slice(0, token.start) + insert + prev.slice(caret))
      setCaret(nextCaret)
      refocus(nextCaret)
    },
    [token, caret, refocus],
  )

  return (
    <div className="ari-glass px-4 pb-3 pt-1">
      <AnimatePresence>
        {queued.length > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={transitions.fadeUp}
            className="mb-2 flex items-center gap-2 rounded-md border border-border bg-glass-input px-3 py-1.5 text-xs text-fg-muted"
          >
            <Clock size={12} className="shrink-0 text-fg-subtle" />
            <span>
              {queued.length} queued message{queued.length > 1 ? 's' : ''} · will send after the
              current turn
            </span>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Zeron-style pill: frosted plate floating over the acrylic backdrop. */}
      <div className="relative rounded-xl border border-border bg-glass-input shadow-2 transition-colors focus-within:border-border-strong">
        {token?.kind === 'slash' && !dismissed && slashItems.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 z-20 mb-1">
            <SlashPopup query={token.raw} onSelect={handleSlashSelect} onClose={closePopup} />
          </div>
        )}
        {token?.kind === 'mention' && !dismissed && mentionItems.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 z-20 mb-1">
            <FilePopup items={mentionItems} onSelect={handleMentionSelect} onClose={closePopup} />
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            syncCaret(e.target)
          }}
          onSelect={(e) => syncCaret(e.currentTarget)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          aria-label="Message"
          className="max-h-[260px] block w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm text-fg placeholder:text-fg-subtle focus:outline-none disabled:opacity-50"
        />
        <div className="flex items-center gap-1 px-2 pb-1.5 pt-0.5">
          {leading}
          <div className="flex-1" />
          <span className="mr-1 hidden text-2xs text-fg-subtle md:block">
            <kbd className="font-mono">Enter</kbd> send ·{' '}
            <kbd className="font-mono">Shift+Enter</kbd> newline
          </span>
          <SendStopButton running={running} onSend={send} onStop={onStop} canSend={text.trim().length > 0} />
        </div>
      </div>
    </div>
  )
}

function SendStopButton({
  running,
  onSend,
  onStop,
  canSend,
}: {
  running: boolean
  onSend: () => void
  onStop?: () => void
  canSend: boolean
}) {
  return (
    <motion.button
      type="button"
      aria-label={running ? 'Stop' : 'Send'}
      onClick={() => (running ? onStop?.() : onSend())}
      disabled={!running && !canSend}
      whileTap={{ scale: 0.92 }}
      transition={transitions.morph}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
        running
          ? 'bg-danger text-fg-on-accent hover:bg-danger-hover'
          : canSend
            ? 'bg-accent text-fg-on-accent hover:bg-accent-hover'
            : 'bg-surface-2 text-fg-subtle'
      }`}
    >
      <AnimatePresence mode="wait" initial={false}>
        {running ? (
          <motion.span
            key="stop"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.09 }}
          >
            <Square size={12} fill="currentColor" />
          </motion.span>
        ) : (
          <motion.span
            key="send"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.09 }}
          >
            <ArrowUp size={15} strokeWidth={2.4} />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  )
}
