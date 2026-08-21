import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, Square } from 'lucide-react'
import { transitions } from '@ari/ui/motion'

export interface ComposerProps {
  /** Called with the message text when the user sends. */
  onSend: (text: string) => void
  /** Called when the user presses stop during an active turn. */
  onStop?: () => void
  /** Whether a turn is currently running for the active session. */
  running?: boolean
  /** Messages waiting behind the active turn. */
  queued?: string[]
  placeholder?: string
  disabled?: boolean
}

const MIN_HEIGHT = 44
const MAX_HEIGHT = 260

/**
 * Message composer: auto-growing textarea, send→stop morph while a turn is
 * running, Enter to send / Shift+Enter for newline.
 */
export function Composer({
  onSend,
  onStop,
  running = false,
  queued = [],
  placeholder = 'Ask, steer, or describe a task…',
  disabled = false,
}: ComposerProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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

  return (
    <div className="border-t border-border bg-surface-0 px-4 py-3">
      <AnimatePresence>
        {queued.length > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={transitions.fadeUp}
            className="mb-2 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-fg-muted"
          >
            {queued.length} queued message{queued.length > 1 ? 's' : ''} · will send after the
            current turn
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex items-end gap-2 rounded-lg border border-border bg-surface-1 p-2 transition-colors focus-within:border-border-strong">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          aria-label="Message"
          className="max-h-[260px] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm text-fg placeholder:text-fg-subtle focus:outline-none disabled:opacity-50"
        />
        <SendStopButton running={running} onSend={send} onStop={onStop} canSend={text.trim().length > 0} />
      </div>

      <div className="mt-1.5 px-1 text-2xs text-fg-subtle">
        <kbd className="font-mono">Enter</kbd> send ·{' '}
        <kbd className="font-mono">Shift+Enter</kbd> newline
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
      whileTap={{ scale: 0.94 }}
      transition={transitions.morph}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
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
            <Square size={13} fill="currentColor" />
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
