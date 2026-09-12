import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, Bookmark, Clock, CornerUpRight, Square, Trash2, X } from 'lucide-react'
import type { AttachmentRef } from '@ari/contracts/attachments'
import { transitions } from '@ari/ui/motion'
import { activeTokenAt } from './active-token'
import { matchSuggestions } from './match-suggestions'
import { FilePopup } from './FilePopup'
import { AttachmentStrip } from './AttachmentStrip'
import { useImageAttachments } from './useImageAttachments'
import { FILE_MIME, osFilePath, quotePathForPrompt, readDragFilePath } from './drag-file'
import { mentionRanges } from './mention-ranges'
import { loadStash, persistStash, stashPrompt, type StashEntry } from './prompt-stash'
import { useDrafts } from './use-drafts'

/**
 * External draft injection (M19.4 edit-and-resend): a changed {@link nonce}
 * replaces the draft with `text`, focuses the field, and parks the caret at
 * the end. Re-delivering the same nonce is a no-op.
 *
 * `files` restores the images a refused send had already taken from the
 * composer, so a retry carries the same context the first attempt did.
 */
export interface ComposerSeed {
  text: string
  nonce: number
  files?: File[]
}

/**
 * One message parked behind the active turn. `attachments` rides along so the
 * steer/remove commands can name the exact queue entry the projection matches
 * on (text plus image set).
 */
export interface QueuedMessageView {
  text: string
  attachments: AttachmentRef[]
}

export interface ComposerProps {
  /** Called with the message text and pending image files when the user sends. */
  onSend: (text: string, files: File[]) => void
  /** Called when the user presses stop during an active turn. */
  onStop?: () => void
  /** Whether a turn is currently running for the active session. */
  running?: boolean
  /** Messages waiting behind the active turn. */
  queued?: QueuedMessageView[]
  /** Pushes one queued message into the running turn. */
  onSteerQueued?: (message: QueuedMessageView) => void
  /** Drops one queued message without running it. */
  onRemoveQueued?: (message: QueuedMessageView) => void
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
  /**
   * Session the unsent draft is keyed to. Switching away and back restores
   * the text; omitted keeps the field in memory only.
   */
  sessionId?: string
  /** Sits on the plate's top edge (child-session rail). */
  above?: React.ReactNode
  /**
   * Something docked above the plate needs an answer (question panel,
   * approval cards). Attention outranks the {@link Composer} resting state:
   * a shrunk plate under "needs your answer" hides the thing to act on.
   * A child-session rail alone does not pin — it is a thin peek strip that
   * asks nothing of the user.
   */
  attentionRequired?: boolean
}

const MIN_HEIGHT = 52
const MAX_HEIGHT = 260

/**
 * The running-turn placeholder. A send during a live turn is journalled to the
 * queue rather than dispatched, so the field says so instead of promising a
 * send it will not perform. Matches the queued banner's "after the current
 * turn" wording; the compact resting bar has no room for the long prompt.
 */
const RUNNING_PLACEHOLDER = 'Message will queue…'

/**
 * Message composer: one glass plate. Draft on top; agent + permission on
 * the left of the foot, stash + send on the right. Enter sends, Shift+Enter
 * breaks the line. The @file popover sits above the field. Pasted or
 * dropped images land in an attachment strip inside the plate and are handed
 * to `onSend` alongside the text — the session view stages them in the main
 * process before dispatching the turn.
 *
 * The plate rests whenever the field is empty and unfocused — during a live
 * turn and after it — folding the foot row into the field's own row and handing
 * the reclaimed height back to the transcript. Clicking or focusing anywhere on
 * it brings the full composer back, and it stays back only for as long as the
 * user is actually in it. Resting is refused whenever it would hide something
 * the user owns — a draft, attached images, or docked attention UI. The
 * textarea is never unmounted, so tab order, focus, and the caret survive every
 * transition.
 */
export function Composer({
  onSend,
  onStop,
  running = false,
  queued = [],
  onSteerQueued,
  onRemoveQueued,
  suggestions,
  leading,
  placeholder = 'Ask anything, @ for files, / for commands…',
  disabled = false,
  seed,
  sessionId,
  above,
  attentionRequired = false,
}: ComposerProps) {
  const { draft: text, setDraft: setText } = useDrafts(sessionId ?? '')
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [stash, setStash] = useState<StashEntry[]>(() => loadStash())
  const [stashOpen, setStashOpen] = useState(false)
  const [stashedPulse, setStashedPulse] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const { images, addFiles, removeAt, clear } = useImageAttachments()
  const [focused, setFocused] = useState(false)

  /**
   * Resting is the compact one-row plate: it happens over any empty, unfocused
   * field, whether or not a turn is live. It deliberately outlives the turn —
   * a plate that springs back open the moment the agent finishes is the
   * jumpiness this state exists to remove, and the user is usually reading the
   * result, not typing. A draft or a pending image is enough to refuse:
   * collapsing would hide text the user wrote, which reads as data loss even
   * though the state is intact.
   */
  const resting =
    !disabled && !focused && !attentionRequired && text.trim().length === 0 && images.length === 0

  /** Puts the caret back in the field and lets focus expand the plate. */
  const focusField = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [])

  /**
   * Focus leaving the plate is the collapse trigger. Blur on the textarea
   * alone would be wrong: the model, effort, and permission chips are real
   * buttons inside the plate, so picking a model would otherwise fold the
   * composer out from under the popover being used.
   */
  const handleShellBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null
    if (next !== null && e.currentTarget.contains(next)) return
    setFocused(false)
  }, [])

  /**
   * A click anywhere on the resting plate (its padding, not just the textarea)
   * reopens the composer. Buttons are exempt so Stop does not also expand it.
   */
  const handleShellMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!resting) return
      if ((e.target as HTMLElement).closest('button') !== null) return
      e.preventDefault()
      focusField()
    },
    [resting, focusField],
  )

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
    // Resting drops the floor: the foot row is gone, so one line plus the
    // resting padding is the whole plate. `resting` is a dependency so the
    // field re-measures against the padding it now carries.
    const floor = resting ? 0 : MIN_HEIGHT
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, floor), MAX_HEIGHT)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
    syncOverlayScroll()
  }, [syncOverlayScroll, resting])

  useEffect(resize, [text, resize])

  // Draft injection: only a fresh nonce applies the seed, so re-renders with
  // the same object never clobber what the user is typing.
  const seededNonceRef = useRef<number | null>(null)
  useEffect(() => {
    if (!seed || seededNonceRef.current === seed.nonce) return
    seededNonceRef.current = seed.nonce
    if (seed.files !== undefined && seed.files.length > 0) addFiles(seed.files)
    setText(seed.text)
    const end = seed.text.length
    setCaret(end)
    // Synchronous focus + caret: deferring via rAF raced user input under
    // load (the caret yank landed between keystrokes and ate characters).
    const el = textareaRef.current
    el?.focus()
    el?.setSelectionRange(end, end)
  }, [seed, addFiles])

  const send = useCallback(() => {
    const trimmed = text.trim()
    if ((trimmed.length === 0 && images.length === 0) || disabled) return
    onSend(trimmed, [...images])
    setText('')
    setCaret(0)
    clear()
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [text, images, disabled, onSend, clear])

  /**
   * Inserts text at the live caret (event target wins over stale state),
   * replacing any selected range the way a paste does.
   */
  const insertAtCaret = useCallback(
    (target: HTMLTextAreaElement | null, fallbackCaret: number, insert: string) => {
      const at = target?.selectionStart ?? fallbackCaret
      const end = target?.selectionEnd ?? fallbackCaret
      const nextCaret = at + insert.length
      setText((prev) => prev.slice(0, at) + insert + prev.slice(Math.max(at, end)))
      setCaret(nextCaret)
      refocus(nextCaret)
    },
    [refocus, setText],
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (e.clipboardData.files.length === 0) return
      const files = Array.from(e.clipboardData.files)
      const images = files.filter((file) => file.type.startsWith('image/'))
      const others = files.filter((file) => !file.type.startsWith('image/'))
      if (images.length > 0) addFiles(images)
      // OS file pastes (e.g. copy + paste from Explorer) land as prompt paths.
      if (others.length > 0) {
        const insert = `${others.map((file) => quotePathForPrompt(osFilePath(file))).join(' ')} `
        insertAtCaret(e.currentTarget, caret, insert)
      }
    },
    [addFiles, caret, insertAtCaret],
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
        const files = Array.from(e.dataTransfer.files)
        const images = files.filter((file) => file.type.startsWith('image/'))
        const others = files.filter((file) => !file.type.startsWith('image/'))
        if (images.length > 0) addFiles(images)
        // OS file drops outside the image path land as prompt paths.
        if (others.length > 0) {
          const insert = `${others.map((file) => quotePathForPrompt(osFilePath(file))).join(' ')} `
          insertAtCaret(e.currentTarget, caret, insert)
        }
      }
    },
    [addFiles, caret, insertAtCaret],
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
            className="mb-2 rounded-md border border-border bg-glass-input py-1.5 text-xs text-fg-muted"
          >
            <div className="flex items-center gap-2 px-3">
              <Clock size={12} className="shrink-0 text-fg-subtle" />
              <span>
                {queued.length} queued message{queued.length > 1 ? 's' : ''} · will send after the
                current turn
              </span>
            </div>
            <ul className="mt-1 space-y-px px-1.5" aria-label="Queued messages">
              {queued.map((message, index) => (
                <li
                  key={`${index}:${message.text}`}
                  className="group flex items-center gap-1 rounded-sm px-1.5 py-1 transition-colors hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate text-fg" title={message.text}>
                    {message.text}
                  </span>
                  {message.attachments.length > 0 ? (
                    <span className="shrink-0 text-2xs text-fg-subtle">
                      {message.attachments.length} image
                      {message.attachments.length > 1 ? 's' : ''}
                    </span>
                  ) : null}
                  {/* Steering rides the provider's text channel, so an imaged
                      message can only ever run as the follow-up turn. */}
                  {onSteerQueued && message.attachments.length === 0 ? (
                    <button
                      type="button"
                      aria-label={`Steer queued message ${index + 1} into the current turn`}
                      title="Steer into the current turn"
                      onClick={() => onSteerQueued(message)}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                    >
                      <CornerUpRight size={11} />
                    </button>
                  ) : null}
                  {onRemoveQueued ? (
                    <button
                      type="button"
                      aria-label={`Remove queued message ${index + 1}`}
                      title="Remove from queue"
                      onClick={() => onRemoveQueued(message)}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                    >
                      <X size={11} />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {above ? (
        <div className="relative z-0 -mb-3 rounded-t-2xl border border-b-0 border-border bg-surface-2/70 pt-0.5">
          <div className="pb-5">{above}</div>
        </div>
      ) : null}
      <div
        onFocus={() => setFocused(true)}
        onBlur={handleShellBlur}
        onMouseDown={handleShellMouseDown}
        data-resting={resting || undefined}
        className="ari-composer-shell relative z-10 rounded-2xl"
      >
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
        <div className="relative">
          <MentionOverlay ref={overlayRef} text={text} resting={resting} />
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
            placeholder={running ? RUNNING_PLACEHOLDER : placeholder}
            disabled={disabled}
            rows={1}
            aria-label="Message"
            className={`block max-h-[260px] w-full resize-none bg-transparent text-sm leading-relaxed text-fg placeholder:text-fg-subtle/70 focus:outline-none disabled:opacity-50 [scrollbar-gutter:stable] ${
              resting
                ? // Symmetric padding centres the single line, and the right
                  // inset keeps the placeholder clear of the overlaid send.
                  'pb-3 pl-4 pr-12 pt-3.5'
                : 'px-4 pt-3.5 pb-2'
            }`}
          />
        </div>
        <div
          className={
            resting
              ? // The foot becomes an overlay on the field's own row, so the
                // SendStopButton sits beside the placeholder instead of below.
                'absolute inset-y-0 right-2 flex items-center'
              : 'flex items-center gap-1 px-2.5 pb-2 pt-1'
          }
        >
          {/* `contents` keeps the chips as direct flex children, so expanding
              and resting lay out identically without remounting the pickers. */}
          <div className={resting ? 'hidden' : 'contents'}>{leading}</div>
          <button
            type="button"
            aria-label="Send message"
            onClick={send}
            disabled={(text.trim().length === 0 && images.length === 0) || disabled || running}
            tabIndex={-1}
            className="sr-only"
          >
            Send
          </button>
          <div
            className={
              resting ? 'flex shrink-0 items-center' : 'ms-auto flex shrink-0 items-center gap-1'
            }
          >
            <div className={resting ? 'hidden' : 'relative'}>
              <motion.button
                key={`stash-pulse-${stashedPulse}`}
                type="button"
                aria-label={`Prompt stash (${stash.length})`}
                title="Stash this prompt (Mod+S) or reuse a stashed one"
                onClick={() => setStashOpen((o) => !o)}
                animate={stashedPulse > 0 ? { scale: [1, 1.25, 1] } : undefined}
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
              canSend={text.trim().length > 0 || images.length > 0}
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
 * textarea's onScroll/resize. Sits inside the same `relative` wrapper as the
 * textarea (NOT the plate) so it is clipped to the field's own box — over the
 * foot row it used to bleed onto the send controls once the text exceeded
 * MAX_HEIGHT — and reserves the same scrollbar gutter so wrapping matches
 * while the textarea scrolls.
 */
const MentionOverlay = forwardRef<HTMLDivElement, { text: string; resting: boolean }>(
  function MentionOverlay({ text, resting }, ref) {
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
      className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words pt-3.5 text-sm leading-relaxed text-fg [scrollbar-gutter:stable] ${
        resting ? 'pl-4 pr-12' : 'px-4'
      }`}
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
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-all duration-[var(--ari-dur-fast)] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring shadow-sm ${
        running
          ? 'bg-busy text-fg-on-accent hover:brightness-110 shadow-busy/20'
          : canSend
            ? 'bg-accent text-fg-on-accent hover:bg-accent-hover hover:scale-105 active:scale-95 shadow-accent/25'
            : 'bg-surface-3/50 text-fg-subtle opacity-60'
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
