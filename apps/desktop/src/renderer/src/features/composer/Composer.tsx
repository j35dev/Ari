import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, Bookmark, Clock, Square, Trash2 } from 'lucide-react'
import { transitions } from '@ari/ui/motion'
import { activeTokenAt } from './active-token'
import type { SlashCommand } from './slash-commands'
import { matchSlash } from './slash-commands'
import { matchSuggestions } from './match-suggestions'
import { SlashPopup } from './SlashPopup'
import { FilePopup } from './FilePopup'
import { AttachmentStrip } from './AttachmentStrip'
import { useImageAttachments } from './useImageAttachments'
import { FILE_MIME, readDragFilePath } from './drag-file'
import { mentionRanges } from './mention-ranges'
import {
  loadStash,
  persistStash,
  stashPrompt,
  type StashEntry,
} from './prompt-stash'

/**
 * External draft injection (M19.4 edit-and-resend): a changed {@link nonce}
 * replaces the draft with `text`, focuses the field, and parks the caret at
 * the end. Re-delivering the same nonce is a no-op.
 */
export interface ComposerSeed {
  text: string
  nonce: number
}

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
  /**
   * Context chips inside the plate (agent picker, permission). Lives with
   * the draft so the next turn's agent is visible without leaving the box.
   */
  leading?: React.ReactNode
  placeholder?: string
  disabled?: boolean
  /** Draft injection from outside (edit a transcript message); see {@link ComposerSeed}. */
  seed?: ComposerSeed
}

const MIN_HEIGHT = 52
const MAX_HEIGHT = 260

/**
 * Message composer: one glass plate. Draft on top; agent + permission on
 * the left of the foot, stash + send on the right. Enter sends, Shift+Enter
 * breaks the line. Slash and @file popovers sit above the field. Pasted or
 * dropped images land in an attachment strip inside the plate.
 */
export function Composer({
  onSend,
  onStop,
  running = false,
  queued = [],
  onSlashCommand,
  suggestions,
  leading,
  placeholder = 'Ask Ari…',
  disabled = false,
  seed,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [stash, setStash] = useState<StashEntry[]>(() => loadStash())
  const [stashOpen, setStashOpen] = useState(false)
  const [stashedPulse, setStashedPulse] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const { images, addFiles, removeAt, clear } = useImageAttachments()

  /** Keeps the mention highlight glued to the textarea's scroll position. */
  const syncOverlayScroll = useCallback(() => {
    const overlay = overlayRef.current
    const textarea = textareaRef.current
    if (overlay && textarea) overlay.scrollTop = textarea.scrollTop
  }, [])

  /** Mod+S: stash the current draft (git-stash semantics — the field clears). */
  const stashDraft = useCallback(() => {
    if (text.trim().length === 0) return
    setStash((prev) => {
      const next = stashPrompt(text, prev)
      persistStash(next)
      return next
    })
    setText('')
    setCaret(0)
    setStashedPulse((p) => p + 1)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [text])

  const restoreFromStash = useCallback((entry: StashEntry) => {
    setStashOpen(false)
    setText(entry.text)
    const end = entry.text.length
    setCaret(end)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(end, end)
    })
  }, [])

  const removeFromStash = useCallback((entry: StashEntry) => {
    setStash((prev) => {
      const next = prev.filter((e) => e.text !== entry.text)
      persistStash(next)
      return next
    })
  }, [])

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
    // Synchronous on purpose: a rAF here fired between keystrokes under load
    // (yanking the caret mid-typing) and made focus assertions flaky.
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(caretIndex, caretIndex)
  }, [])

  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
    syncOverlayScroll()
  }, [syncOverlayScroll])

  useEffect(resize, [text, resize])

  // Draft injection: only a fresh nonce applies the seed, so re-renders with
  // the same object never clobber what the user is typing.
  const seededNonceRef = useRef<number | null>(null)
  useEffect(() => {
    if (!seed || seededNonceRef.current === seed.nonce) return
    seededNonceRef.current = seed.nonce
    setText(seed.text)
    const end = seed.text.length
    setCaret(end)
    // Synchronous focus + caret: deferring via rAF raced user input under
    // load (the caret yank landed between keystrokes and ate characters).
    const el = textareaRef.current
    el?.focus()
    el?.setSelectionRange(end, end)
  }, [seed])

  const send = useCallback(() => {
    const trimmed = text.trim()
    if (trimmed.length === 0 || disabled) return
    onSend(trimmed)
    setText('')
    // Pending images are visual-only for now: handing real file paths to
    // turn.start needs a staging IPC in the main process (sandboxed
    // renderers cannot resolve File paths), so they clear on send.
    clear()
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [text, disabled, onSend, clear])

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (e.clipboardData.files.length > 0) addFiles(e.clipboardData.files)
    },
    [addFiles],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      // In-app file drags (explorer/changes rows) become @file mentions.
      const path = readDragFilePath(e)
      if (path !== null) {
        e.preventDefault()
        const insert = `@${path} `
        const nextCaret = caret + insert.length
        setText((prev) => prev.slice(0, caret) + insert + prev.slice(caret))
        setCaret(nextCaret)
        refocus(nextCaret)
        return
      }
      if (e.dataTransfer.files.length > 0) {
        e.preventDefault()
        addFiles(e.dataTransfer.files)
      }
    },
    [addFiles, caret, refocus],
  )

  const handleDragOver = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    const types = e.dataTransfer.types
    if (types.includes('Files') || types.includes(FILE_MIME)) e.preventDefault()
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        send()
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        stashDraft()
      }
    },
    [send, stashDraft],
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
    <div className="px-4 pb-4 pt-2">
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

      <div className="relative rounded-lg border border-border bg-glass-input shadow-2">
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
        {images.length > 0 && (
          <div className="px-3 pt-2">
            <AttachmentStrip images={images} onRemove={removeAt} />
          </div>
        )}
        <MentionOverlay ref={overlayRef} text={text} />
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            syncCaret(e.target)
          }}
          onSelect={(e) => syncCaret(e.currentTarget)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onScroll={syncOverlayScroll}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          aria-label="Message"
          className="block max-h-[260px] w-full resize-none bg-transparent px-4 pt-3.5 text-sm leading-relaxed text-fg placeholder:text-fg-subtle focus:outline-none disabled:opacity-50"
        />
        <div className="flex items-center gap-1 px-2.5 pb-2 pt-1">
          {leading}
          <button
            type="button"
            aria-label="Send message"
            onClick={send}
            disabled={text.trim().length === 0 || disabled || running}
            tabIndex={-1}
            className="sr-only"
          >
            Send
          </button>
          <div className="ms-auto flex shrink-0 items-center gap-1">
            <div className="relative">
              <motion.button
                key={`stash-pulse-${stashedPulse}`}
                type="button"
                aria-label={`Prompt stash (${stash.length})`}
                title="Stash this prompt (Mod+S) or reuse a stashed one"
                onClick={() => setStashOpen((o) => !o)}
                animate={
                  stashedPulse > 0 ? { scale: [1, 1.25, 1] } : undefined
                }
                transition={{ duration: 0.35, ease: 'easeOut' }}
                className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                <Bookmark size={13} />
              </motion.button>
              <AnimatePresence>
                {stashOpen ? (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setStashOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: 4, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 4, scale: 0.97 }}
                      transition={transitions.menuIn}
                      className="ari-glass-overlay absolute bottom-full right-0 z-40 mb-2 max-h-72 w-80 overflow-y-auto rounded-lg border border-border p-1 shadow-2"
                      role="menu"
                      aria-label="Stashed prompts"
                    >
                      {stash.length === 0 ? (
                        <p className="px-3 py-4 text-center text-xs text-fg-subtle">
                          Nothing stashed yet.
                          <br />
                          Press Mod+S to save the current draft.
                        </p>
                      ) : (
                        stash.map((entry) => (
                          <div
                            key={entry.savedAt}
                            className="group flex items-start gap-1 rounded-sm"
                            role="none"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => restoreFromStash(entry)}
                              className="min-w-0 flex-1 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                            >
                              <span className="line-clamp-2 block whitespace-pre-wrap break-words text-xs leading-snug text-fg">
                                {entry.text}
                              </span>
                              <span className="mt-0.5 block text-2xs tabular-nums text-fg-subtle">
                                {new Date(entry.savedAt).toLocaleString()}
                              </span>
                            </button>
                            <button
                              type="button"
                              aria-label="Remove from stash"
                              onClick={() => removeFromStash(entry)}
                              className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-fg-subtle opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        ))
                      )}
                    </motion.div>
                  </>
                ) : null}
              </AnimatePresence>
            </div>
            <SendStopButton
              running={running}
              onSend={send}
              onStop={onStop}
              canSend={text.trim().length > 0}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Mirror of the textarea's text with `@path` mentions highlighted, painted
 * underneath the transparent textarea (highlight-within-textarea pattern).
 * Must keep the textarea's exact typography, padding and wrapping so the two
 * layers stay aligned character-for-character; scroll is synced by the
 * textarea's onScroll/resize.
 */
const MentionOverlay = forwardRef<HTMLDivElement, { text: string }>(function MentionOverlay(
  { text },
  ref,
) {
  const ranges = mentionRanges(text)
  if (ranges.length === 0) return null
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) {
      parts.push(<span key={cursor}>{text.slice(cursor, range.start)}</span>)
    }
    parts.push(
      <mark key={range.start} className="rounded-sm bg-accent-subtle text-fg">
        {text.slice(range.start, range.end)}
      </mark>,
    )
    cursor = range.end
  }
  if (cursor < text.length) {
    parts.push(<span key={cursor}>{text.slice(cursor)}</span>)
  }
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 pt-3.5 text-sm leading-relaxed text-fg"
    >
      {parts}
    </div>
  )
})

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
      title={running ? 'Stop' : 'Send'}
      onClick={() => (running ? onStop?.() : onSend())}
      disabled={!running && !canSend}
      whileTap={{ scale: 0.96 }}
      transition={transitions.morph}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-[var(--ari-dur-fast)] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
        running
          ? 'bg-busy text-fg-on-accent hover:brightness-110'
          : canSend
            ? 'bg-accent text-fg-on-accent hover:bg-accent-hover'
            : 'bg-surface-3 text-fg-subtle'
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
