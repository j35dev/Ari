import {
  forwardRef,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { motion } from 'motion/react'
import { ArrowUp, Bookmark, CornerUpRight, Pencil, Square, Trash2, X } from 'lucide-react'
import type { AttachmentRef } from '@ari/contracts/attachments'
import type { MessageOrigin } from '@ari/contracts/message'
import { transitions } from '@ari/ui/motion'
import { Popover } from '@ari/ui/popover'
import { countBadge, cx, iconButton, iconButtonActive, rowAction } from '../../lib/recipes'
import { activeTokenAt } from './active-token'
import { matchSuggestions } from './match-suggestions'
import { FilePopup } from './FilePopup'
import { AttachmentStrip } from './AttachmentStrip'
import { useImageAttachments } from './useImageAttachments'
import {
  FILE_MIME,
  FILE_SCOPE_MIME,
  osFilePath,
  quotePathForPrompt,
  readDragFilePath,
} from './drag-file'
import { mentionRanges } from './mention-ranges'
import { loadStash, persistStash, stashPrompt, type StashEntry } from './prompt-stash'
import { promptHistory, stepPromptHistory } from './prompt-history'
import { createPasteId, decidePasteFile } from './paste-as-file'
import { useDrafts } from './use-drafts'
import { SpeechButton, type SpeechState } from './SpeechButton'
import { roundButton } from './round-button'
import { captureTextTarget } from '../speech/target'
import {
  useSessionDraftIntent,
  updateSessionDraftIntent,
  type DraftImage,
  type DraftDelivery,
} from './draft-recovery-store'
import './composer.css'
import { parseSessionViewKey, useSessionClient } from '../session/session-client'

/**
 * External draft injection (M19.4 edit-and-resend): a changed {@link nonce}
 * replaces the draft with `text`, focuses the field, and parks the caret at
 * the end. Re-delivering the same nonce is a no-op. `mode: 'insert'` splices
 * `text` at the caret instead, and leaves the rest of the draft in place.
 *
 * `files` restores the images a refused send had already taken from the
 * composer, so a retry carries the same context the first attempt did.
 */
export interface ComposerSeed {
  text: string
  nonce: number
  files?: File[]
  images?: DraftImage[]
  sessionId?: string
  /** Recovery swaps the complete draft, including an empty image set. */
  replaceFiles?: boolean
  /** Automatic recovery must not take focus from another control/session. */
  focus?: boolean
  /** `replace` overwrites the draft. `insert` splices at the caret. */
  mode?: 'replace' | 'insert'
}

export interface ComposerDraft {
  text: string
  files: File[]
  images?: DraftImage[]
}

export interface ComposerRecovery extends ComposerDraft {
  id: string
  autoRestore?: boolean
  delivery?: DraftDelivery
}

const NO_RECOVERIES: ComposerRecovery[] = []

/**
 * One message parked behind the active turn. `attachments` rides along so the
 * steer/remove commands can name the exact queue entry the projection matches
 * on (text plus image set).
 */
export interface QueuedMessageView {
  text: string
  attachments: AttachmentRef[]
  origin?: MessageOrigin
  senderLabel?: string
}

export interface ComposerProps {
  /** Announces a mounted, enabled editor; the owner decides whether to focus it. */
  onReady?: (input: HTMLTextAreaElement) => void
  /** Called with the message text and pending image files when the user sends. */
  onSend: (text: string, files: File[], images?: DraftImage[]) => boolean | void
  /** Waiting for preparation/dispatch; typing and Stop remain available. */
  sendPending?: boolean
  recoveries?: ComposerRecovery[]
  onRecover?: (message: ComposerRecovery, current: ComposerDraft, focus: boolean) => boolean
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
  /** Takes one queued text message back into the composer for editing. */
  onEditQueued?: (message: QueuedMessageView) => void
  /** Workspace paths offered by the @file mention popup; absent hides it. */
  suggestions?: string[]
  /**
   * Context chips inside the plate (agent picker, permission). Lives with
   * the draft so the next turn's agent is visible without leaving the box.
   */
  leading?: React.ReactNode
  /** Project draft controls outside the plate; existing sessions leave this empty. */
  belowControls?: React.ReactNode
  /** Drafts retain large pasted text locally until the host session exists. */
  draftOnly?: boolean
  /** A remote or unresolved project draft cannot use this PC's input services. */
  remoteInput?: boolean
  placeholder?: string
  disabled?: boolean
  /** Draft injection from outside (edit a transcript message); see {@link ComposerSeed}. */
  seed?: ComposerSeed
  /**
   * Session the unsent draft is keyed to. Switching away and back restores
   * the text; omitted keeps the field in memory only.
   */
  sessionId?: string
  /**
   * Rows attached to the composer's top edge as a tab: approvals, a question,
   * the agents row. Each entry brings its own padding; the tab is the frame.
   */
  above?: React.ReactNode
  /**
   * Something docked above the composer needs an answer (question panel,
   * approval cards). Attention outranks the {@link Composer} resting state:
   * the composer never folds to its compact bar under a card that is waiting
   * on the user.
   */
  attentionRequired?: boolean
  /** The welcome composer: a taller field over the scene. */
  centered?: boolean
  /** Prompts already sent in this session, oldest first; ArrowUp in an empty field recalls them. */
  history?: readonly string[]
}

/** About two lines of draft: the field's floor in a session. */
const MIN_HEIGHT = 62
/** The welcome composer's floor. */
const CENTERED_MIN_HEIGHT = 88
const MAX_HEIGHT = 260

/**
 * The running-turn placeholder. A send during a live turn is journalled to the
 * queue rather than dispatched, so the field says so instead of promising a
 * send it will not perform. Matches the queued tab's "after the current turn"
 * wording.
 */
const RUNNING_PLACEHOLDER = 'Message will queue…'

/** A tab on the composer's top edge: queued messages, approvals, questions. */
const TOP_TAB = 'mx-3.5 border border-b-0 border-border-strong bg-bg'

/**
 * Message composer: one object on the stage. Open, the draft sits on top and
 * one row of controls sits under it: the pickers handed in through `leading`
 * on the left, then stash, microphone and the round send button on the right.
 * Enter sends, Shift+Enter breaks the line. The @file menu opens above the
 * field. Pasted or dropped images become chips inside the box and are handed
 * to `onSend` alongside the text; the session view stages them in the main
 * process before dispatching the turn.
 *
 * The composer rests whenever the field is empty and unfocused — during a live
 * turn and after it — folding to one compact row (placeholder, microphone,
 * send) and handing the reclaimed height back to the transcript. Clicking or
 * focusing anywhere on it opens it again, and it stays open only for as long
 * as the user is actually in it. Resting is refused whenever it would hide
 * something the user owns: a draft, attached images, or docked attention UI.
 * The textarea is never unmounted, so tab order, focus and the caret survive
 * every transition.
 *
 * While a dictation runs the control row belongs to it: "Listening", the
 * level meter and the timer replace the pickers, and the round button finishes
 * the recording. The pickers stay mounted so an open choice survives it.
 */
export function Composer({
  onSend,
  onStop,
  running = false,
  queued = [],
  onSteerQueued,
  onRemoveQueued,
  onEditQueued,
  suggestions,
  leading,
  belowControls,
  draftOnly = false,
  remoteInput = false,
  placeholder = 'Ask anything, @ for files, / for commands…',
  disabled = false,
  seed,
  sessionId,
  above,
  attentionRequired = false,
  centered = false,
  history,
  onReady,
  sendPending = false,
  recoveries = NO_RECOVERIES,
  onRecover,
}: ComposerProps) {
  const client = useSessionClient()
  const inputScope = sessionId ? parseSessionViewKey(sessionId) : null
  const remote = remoteInput || client.scope.kind === 'remote' || inputScope?.kind === 'remote'
  const scopedRemote =
    client.scope.kind === 'remote' &&
    (sessionId === client.viewKey || sessionId === client.scope.sessionId)
  const [inputIssue, setInputIssue] = useState<string | null>(null)
  useEffect(() => setInputIssue(null), [sessionId, remote])
  const {
    draft: text,
    setDraft: setText,
    storageIssue: textStorageIssue,
  } = useDrafts(sessionId ?? '')
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [stash, setStash] = useState<StashEntry[]>(() => loadStash())
  const [stashOpen, setStashOpen] = useState(false)
  const [stashAnchor, setStashAnchor] = useState<HTMLDivElement | null>(null)
  const [stashedPulse, setStashedPulse] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const input = textareaRef.current
    if (onReady && input && !disabled) onReady(input)
  }, [onReady, disabled])
  const overlayRef = useRef<HTMLDivElement>(null)
  const { images, intents, addFiles, removeAt, removeIntentAt, replace, clear } =
    useImageAttachments(sessionId)
  const draftIntent = useSessionDraftIntent(sessionId ?? '')
  const missingImages =
    draftIntent.reattachRequired ||
    intents.some((image) => !image.file && !image.ref) ||
    draftIntent.picks.some((pick) => pick.imageIntent && !pick.image && !pick.imageIntent.ref)
  /** The dictation's state, reported by the microphone; it reshapes the control row. */
  const [dictation, setDictation] = useState<SpeechState>('idle')
  /** The left of the control row, lent to the microphone for its status strip. */
  const [dictationSlot, setDictationSlot] = useState<HTMLSpanElement | null>(null)
  const dictating = dictation === 'recording' || dictation === 'transcribing'
  const [focused, setFocused] = useState(false)

  /**
   * Resting is the compact one-row bar: it happens over any empty, unfocused
   * field, whether or not a turn is live. It deliberately outlives the turn —
   * a composer that springs back open the moment the agent finishes is the
   * jumpiness this state exists to remove, and the user is usually reading the
   * result, not typing. A draft or a pending image is enough to refuse:
   * collapsing would hide text the user wrote, which reads as data loss even
   * though the state is intact. A dictation holds the control row, so it
   * refuses too.
   */
  const resting =
    !centered &&
    !disabled &&
    !focused &&
    !dictating &&
    !attentionRequired &&
    text.trim().length === 0 &&
    intents.length === 0 &&
    recoveries.length === 0 &&
    !draftIntent.delivery &&
    !draftIntent.reattachRequired &&
    !draftIntent.storageIssue &&
    !textStorageIssue &&
    !sendPending

  /** Puts the caret back in the field and lets focus open the composer. */
  const focusField = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [])

  /**
   * Focus leaving the composer is the collapse trigger. Blur on the textarea
   * alone would be wrong: the model, effort and permission pickers are real
   * buttons inside it, so picking a model would otherwise fold the composer
   * out from under the menu being used.
   */
  const handleShellBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null
    if (next !== null && e.currentTarget.contains(next)) return
    setFocused(false)
  }, [])

  /**
   * A click anywhere on the resting bar (its padding, not just the textarea)
   * reopens the composer. Buttons are exempt so Stop does not also open it.
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

  // The popup filters a deferred query: a large file index is ranked after
  // the keystroke paints, never in its way.
  const mentionQuery = useDeferredValue(token?.kind === 'mention' ? token.raw.slice(1) : null)
  const mentionItems = useMemo(
    () => (mentionQuery !== null && suggestions ? matchSuggestions(suggestions, mentionQuery) : []),
    [mentionQuery, suggestions],
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

  // What the last measure saw: typing forward can only grow the field, so it
  // skips the collapse-and-remeasure that costs a second layout per keystroke.
  const measuredRef = useRef({ length: 0, lines: 0, floor: -1 })
  const resize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    // Resting drops the floor: the control row is gone, so one line plus the
    // resting padding is the whole bar. `resting` is a dependency so the
    // field re-measures against the padding it now carries.
    const floor = resting ? 0 : centered ? CENTERED_MIN_HEIGHT : MIN_HEIGHT
    const length = el.value.length
    const lines = el.value.split('\n').length
    const last = measuredRef.current
    const mayShrink = length < last.length || lines < last.lines || floor !== last.floor
    measuredRef.current = { length, lines, floor }
    if (mayShrink) el.style.height = 'auto'
    else if (el.scrollHeight <= el.clientHeight) {
      syncOverlayScroll()
      return
    }
    el.style.height = `${Math.min(Math.max(el.scrollHeight, floor), MAX_HEIGHT)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
    syncOverlayScroll()
  }, [syncOverlayScroll, resting, centered])

  useEffect(resize, [text, resize])

  // Reflow an existing draft when its font, text size, or pane width changes.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const remeasure = (): void => {
      measuredRef.current.floor = -1
      resize()
    }
    const appearanceObserver = new MutationObserver(remeasure)
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-ari-chat-style'],
    })
    let lastWidth = -1
    const widthObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width === undefined || width === lastWidth) return
      lastWidth = width
      remeasure()
    })
    widthObserver.observe(el)
    document.fonts?.addEventListener('loadingdone', remeasure)
    return () => {
      appearanceObserver.disconnect()
      widthObserver.disconnect()
      document.fonts?.removeEventListener('loadingdone', remeasure)
    }
  }, [resize])

  // Draft injection: only a fresh nonce applies the seed, so re-renders with
  // the same object never clobber what the user is typing.
  const seededNonceRef = useRef<string | null>(null)
  // Insert mode has to place the caret after React commits the new value.
  // Setting it in the seed effect lands on the pre-update textarea.
  const seedCaretRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    const next = seedCaretRef.current
    if (next === null) return
    seedCaretRef.current = null
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(next, next)
  }, [text])
  useEffect(() => {
    if (!seed || (seed.sessionId !== undefined && seed.sessionId !== sessionId)) return
    const key = `${seed.sessionId ?? sessionId ?? ''}:${seed.nonce}`
    if (seededNonceRef.current === key) return
    seededNonceRef.current = key
    if (seed.images !== undefined) replace(seed.images)
    else {
      if (seed.replaceFiles) clear()
      if (seed.files !== undefined && seed.files.length > 0) addFiles(seed.files)
    }
    const el = textareaRef.current
    if (seed.mode === 'insert') {
      const at = el?.selectionStart ?? 0
      const end = el?.selectionEnd ?? at
      const next = at + seed.text.length
      seedCaretRef.current = next
      setText((prev) => prev.slice(0, at) + seed.text + prev.slice(Math.max(at, end)))
      setCaret(next)
      return
    }
    setText(seed.text)
    const end = seed.text.length
    setCaret(end)
    // Synchronous focus + caret: deferring via rAF raced user input under
    // load (the caret yank landed between keystrokes and ate characters).
    if (seed.focus !== false) {
      el?.focus()
      el?.setSelectionRange(end, end)
    }
  }, [seed, sessionId, addFiles, clear, replace, setText])

  const seenRecoveriesRef = useRef(new Set<string>())
  useEffect(() => {
    if (sendPending) return
    const added = recoveries.filter((message) => !seenRecoveriesRef.current.has(message.id))
    seenRecoveriesRef.current = new Set(recoveries.map((message) => message.id))
    const next = added.find((message) => message.autoRestore !== false)
    if (next && text.length === 0 && intents.length === 0) {
      onRecover?.(next, { text, files: [] }, false)
    }
  }, [recoveries, sendPending, text, intents.length, onRecover])

  const send = useCallback(() => {
    const trimmed = text.trim()
    if ((trimmed.length === 0 && intents.length === 0) || disabled || sendPending || missingImages)
      return
    const accepted = intents.some((image) => image.ref)
      ? onSend(trimmed, [...images], intents)
      : onSend(trimmed, [...images])
    if (accepted === false) return
    setText('')
    setCaret(0)
    clear()
    if (sessionId) updateSessionDraftIntent(sessionId, (prev) => ({ ...prev, delivery: undefined }))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [
    text,
    images,
    intents,
    disabled,
    sendPending,
    missingImages,
    sessionId,
    onSend,
    clear,
    setText,
  ])

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

  // A paste event does not carry Ctrl/Shift. Remember them from the keys
  // that are down so Ctrl/Cmd+Shift+V can stay inline.
  const forceInlinePasteRef = useRef(false)
  useEffect(() => {
    const sync = (event: KeyboardEvent): void => {
      forceInlinePasteRef.current = (event.ctrlKey || event.metaKey) && event.shiftKey
    }
    const clear = (): void => {
      forceInlinePasteRef.current = false
    }
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
      window.removeEventListener('blur', clear)
    }
  }, [])

  const insertRange = useCallback(
    (at: number, end: number, insert: string) => {
      const nextCaret = at + insert.length
      seedCaretRef.current = nextCaret
      setText((prev) => prev.slice(0, at) + insert + prev.slice(Math.max(at, end)))
      setCaret(nextCaret)
    },
    [setText],
  )

  const pasteSelectionRef = useRef<{ start: number; end: number } | null>(null)
  useLayoutEffect(() => {
    const selection = pasteSelectionRef.current
    pasteSelectionRef.current = null
    const el = textareaRef.current
    if (selection && el) {
      el.setSelectionRange(selection.start, selection.end)
    }
  }, [text])

  // A completed write must not touch a different session or an unmounted editor.
  const pasteGenerationRef = useRef(0)
  useLayoutEffect(
    () => () => {
      pasteGenerationRef.current += 1
    },
    [sessionId, client.viewKey],
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (e.clipboardData.files.length > 0) {
        e.preventDefault()
        const files = Array.from(e.clipboardData.files)
        const images = files.filter((file) => file.type.startsWith('image/'))
        const others = files.filter((file) => !file.type.startsWith('image/'))
        if (images.length > 0) addFiles(images)
        // OS file pastes (e.g. copy + paste from Explorer) land as prompt paths.
        if (others.length > 0 && remote)
          setInputIssue(
            'Files from this PC cannot be referenced on a remote machine. Paste image bytes or text instead.',
          )
        else if (others.length > 0) {
          const insert = `${others.map((file) => quotePathForPrompt(osFilePath(file))).join(' ')} `
          insertAtCaret(e.currentTarget, caret, insert)
        }
        return
      }
      const pasted = e.clipboardData.getData('text/plain')
      if (pasted.length === 0) return
      const start = e.currentTarget.selectionStart ?? caret
      const end = e.currentTarget.selectionEnd ?? start
      const native = e.nativeEvent as ClipboardEvent & {
        ctrlKey?: boolean
        metaKey?: boolean
        shiftKey?: boolean
      }
      const forced =
        forceInlinePasteRef.current ||
        ((native.ctrlKey === true || native.metaKey === true) && native.shiftKey === true)
      const decision = decidePasteFile({
        pasted,
        draft: text,
        selectionStart: start,
        selectionEnd: end,
        forceInline: forced,
        id: createPasteId(),
      })
      if (decision.action === 'inline') return
      e.preventDefault()
      // No session means no workspace to write into, so the text stays inline.
      if (
        sessionId === undefined ||
        draftOnly ||
        inputScope === null ||
        (remote && !scopedRemote)
      ) {
        insertRange(start, end, pasted)
        return
      }
      // Keep the content in the draft before starting IPC. Sending, typing,
      // reloading, or leaving this session during the write must not lose it.
      const inlineDraft = text.slice(0, start) + pasted + text.slice(end)
      insertRange(start, end, pasted)
      const generation = pasteGenerationRef.current
      void client
        .invoke('fs.writeTextFile', {
          sessionId: scopedRemote ? client.scope.sessionId : sessionId,
          path: decision.path,
          content: decision.content,
        })
        .then(
          (result) => {
            // Remote paste paths are issued by the owning host, never chosen locally.
            const hostPath = (result as { path?: string } | undefined)?.path
            if (remote && !hostPath) return
            const mention = `@${hostPath ?? decision.path} `
            // Only compact an untouched draft. A captured selection no longer
            // names the same text after an edit, send, or replacement seed.
            if (pasteGenerationRef.current !== generation) return
            const el = textareaRef.current
            if (el?.value !== inlineDraft) return
            // Keep a moved caret/selection and do not reclaim focus on completion.
            const remap = (index: number) =>
              index <= start
                ? index
                : Math.max(start + mention.length, index - pasted.length + mention.length)
            pasteSelectionRef.current = {
              start: remap(el.selectionStart),
              end: remap(el.selectionEnd),
            }
            setCaret(pasteSelectionRef.current.start)
            setText(text.slice(0, start) + mention + text.slice(end))
          },
          () => {
            // The inline fallback is already present, including any later edits.
          },
        )
    },
    [
      addFiles,
      caret,
      client,
      draftOnly,
      inputScope,
      insertAtCaret,
      insertRange,
      remote,
      scopedRemote,
      sessionId,
      setText,
      text,
    ],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      // In-app file drags (explorer/changes rows) become @file mentions.
      const path = readDragFilePath(e)
      if (path !== null) {
        e.preventDefault()
        const owner = e.dataTransfer.getData(FILE_SCOPE_MIME)
        if (
          remote
            ? !scopedRemote || owner !== client.viewKey
            : owner.length > 0 && owner !== client.viewKey
        ) {
          setInputIssue(
            'This file reference belongs to another workspace. Choose a file on the owning machine.',
          )
          return
        }
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
        if (others.length > 0 && remote)
          setInputIssue(
            'Files from this PC cannot be referenced on a remote machine. Paste image bytes or text instead.',
          )
        else if (others.length > 0) {
          const insert = `${others.map((file) => quotePathForPrompt(osFilePath(file))).join(' ')} `
          insertAtCaret(e.currentTarget, caret, insert)
        }
      }
    },
    [addFiles, caret, client, insertAtCaret, remote, scopedRemote],
  )

  const handleDragOver = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    const types = e.dataTransfer.types
    if (types.includes('Files') || types.includes(FILE_MIME)) e.preventDefault()
  }, [])

  /**
   * Prompt recall. The arrows only leave their ordinary job when the field is
   * empty or still showing a recalled prompt untouched, so they never eat a
   * caret move inside a draft the user is writing.
   */
  const recalledRef = useRef<{ index: number; text: string } | null>(null)
  const recallPrompt = useCallback(
    (direction: 'older' | 'newer'): boolean => {
      if (history === undefined) return false
      const recalled = recalledRef.current?.text === text ? recalledRef.current : null
      if (recalled === null && text.length > 0) return false
      const step = stepPromptHistory(promptHistory(history), recalled?.index ?? null, direction)
      if (step === null) return false
      recalledRef.current = step.index === null ? null : { index: step.index, text: step.text }
      setText(step.text)
      setCaret(step.text.length)
      refocus(step.text.length)
      return true
    },
    [history, text, setText, refocus],
  )

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
      const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
      // Alt+Up at the start of the field pulls the newest queued text message
      // back into the composer. Imaged rows stay queued: an edit draft is text.
      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowUp') {
        const atStart = (e.currentTarget.selectionStart ?? caret) === 0
        const lastText = [...queued]
          .reverse()
          .find(
            (message) =>
              message.attachments.length === 0 &&
              (!message.origin || message.origin.kind === 'human'),
          )
        if (atStart && onEditQueued && lastText !== undefined) {
          e.preventDefault()
          onEditQueued(lastText)
        }
      }
      if (plain && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.nativeEvent.isComposing) {
        if (recallPrompt(e.key === 'ArrowUp' ? 'older' : 'newer')) e.preventDefault()
      }
    },
    [send, stashDraft, recallPrompt, queued, caret, onEditQueued],
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
    <div className="ari-composer-content px-4 pb-4 pt-2">
      {/* Enter-only: an exit animation kept the removed tab painted with its
          last messages, and a stalled one (a backgrounded window) left a sent
          message looking queued, whose remove then failed in the engine. */}
      {queued.length > 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transitions.fadeUp}
          className={cx(TOP_TAB, 'rounded-t-[14px] px-2 pb-1.5 pt-2')}
        >
          <div className="flex items-center gap-2 px-1.5 text-xs text-fg-subtle">
            <span aria-hidden className="ari-status" data-status="queued" />
            <span>
              {queued.length} queued message{queued.length > 1 ? 's' : ''} ·{' '}
              {running ? 'waiting for the current turn' : 'waiting to start'}
            </span>
          </div>
          <ul className="mt-1" aria-label="Queued messages">
            {queued.map((message, index) => (
              <li
                key={`${index}:${message.text}`}
                className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[13px] text-fg-muted transition-colors hover:bg-fg/5"
              >
                <span className="min-w-0 flex-1 truncate" title={message.text}>
                  {message.senderLabel ? (
                    <span className="mr-2 text-xs text-fg-subtle">{message.senderLabel}</span>
                  ) : null}
                  {message.text}
                </span>
                {message.attachments.length > 0 ? (
                  <span className="shrink-0 px-1 text-xs text-fg-subtle">
                    {message.attachments.length} image
                    {message.attachments.length > 1 ? 's' : ''}
                  </span>
                ) : null}
                {onSteerQueued && (!message.origin || message.origin.kind === 'human') ? (
                  <button
                    type="button"
                    aria-label={`Steer queued message ${index + 1} into the current turn`}
                    title="Steer into the current turn"
                    onClick={() => onSteerQueued(message)}
                    className={rowAction}
                  >
                    <CornerUpRight size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                ) : null}
                {onEditQueued &&
                message.attachments.length === 0 &&
                (!message.origin || message.origin.kind === 'human') ? (
                  <button
                    type="button"
                    aria-label={`Edit queued message ${index + 1}`}
                    title="Edit in composer"
                    onClick={() => onEditQueued(message)}
                    className={rowAction}
                  >
                    <Pencil size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                ) : null}
                {onRemoveQueued && (!message.origin || message.origin.kind === 'human') ? (
                  <button
                    type="button"
                    aria-label={`Remove queued message ${index + 1}`}
                    title="Remove from queue"
                    onClick={() => onRemoveQueued(message)}
                    className={rowAction}
                  >
                    <X size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </motion.div>
      ) : null}

      {above ? (
        // Under the queued tab this one drops its own round corners and takes
        // a hairline, so the two read as one tab with two sections.
        <div className={cx(TOP_TAB, queued.length > 0 ? 'border-t-border' : 'rounded-t-[14px]')}>
          {above}
        </div>
      ) : null}
      <div
        onFocus={() => setFocused(true)}
        onBlur={handleShellBlur}
        onMouseDown={handleShellMouseDown}
        data-resting={resting || undefined}
        data-dictation={dictating ? dictation : undefined}
        className="ari-composer-shell relative rounded-2xl"
      >
        {token?.kind === 'mention' && !dismissed && mentionItems.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 z-popover mb-1.5">
            <FilePopup items={mentionItems} onSelect={handleMentionSelect} onClose={closePopup} />
          </div>
        )}
        {(intents.length > 0 ||
          draftIntent.reattachRequired ||
          draftIntent.delivery ||
          draftIntent.storageIssue ||
          textStorageIssue) && (
          <div className="flex flex-col gap-1.5 px-[18px] pt-3.5">
            <AttachmentStrip images={images} onRemove={removeAt} />
            {draftIntent.reattachRequired ? (
              <p role="status" className="text-xs text-fg-subtle">
                Saved attachment context is unreadable. Reattach expected images before sending.{' '}
                <button
                  type="button"
                  onClick={() =>
                    sessionId &&
                    updateSessionDraftIntent(sessionId, (prev) => ({
                      ...prev,
                      reattachRequired: false,
                    }))
                  }
                  className="rounded-sm text-fg-muted underline underline-offset-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  Clear unreadable attachment intent
                </button>
              </p>
            ) : null}
            {intents.map((image, index) =>
              !image.file ? (
                <div
                  key={`${image.metadata.name}:${index}`}
                  role="status"
                  className="flex min-h-7 w-fit max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-2/50 py-0.5 pl-2 pr-1 text-xs text-fg-muted"
                >
                  <span className="min-w-0">
                    {image.ref
                      ? `Attached: ${image.metadata.name}`
                      : `Reattach ${image.metadata.name} (${image.metadata.size} bytes) — paste or drop the image`}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${image.metadata.name}`}
                    onClick={() => removeIntentAt(index)}
                    className={rowAction}
                  >
                    <X size={12} strokeWidth={1.75} aria-hidden />
                  </button>
                </div>
              ) : null,
            )}
            {draftIntent.delivery === 'uncertain' ? (
              <p role="status" className="text-xs text-fg-subtle">
                Delivery unknown — check the conversation before sending again.
              </p>
            ) : null}
            {draftIntent.storageIssue || textStorageIssue ? (
              <p role="status" className="text-xs text-fg-subtle">
                Draft is kept in memory. Local storage is unavailable or full; keep this window
                open.
              </p>
            ) : null}
          </div>
        )}
        <div className="relative">
          <MentionOverlay ref={overlayRef} text={text} />
          <textarea
            data-dictation-session={sessionId ?? ''}
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
            className={`ari-composer-field block max-h-[260px] w-full resize-none bg-transparent leading-relaxed text-fg placeholder:text-fg-subtle focus:outline-none disabled:opacity-50 [scrollbar-gutter:stable] ${
              resting
                ? // Even padding centres the single line, and the right inset
                  // keeps the placeholder clear of the controls laid over it.
                  'py-3 pl-[18px] pr-24'
                : 'px-[18px] pb-1.5 pt-4'
            }`}
          />
        </div>
        <div
          className={
            resting
              ? // The control row becomes an overlay on the field's own row,
                // so the microphone and send sit beside the placeholder.
                'absolute inset-y-0 right-2 flex items-center'
              : 'flex items-center gap-0.5 px-2.5 pb-2.5'
          }
        >
          {/* Hidden, not unmounted, while resting or while a dictation owns
              the row: a picker keeps its state and its place in the tab order
              comes back. */}
          <div
            className={
              resting || dictating ? 'hidden' : 'flex min-w-0 flex-1 flex-wrap items-center gap-0.5'
            }
          >
            {leading}
          </div>
          {/* The microphone draws "Listening", the meter and the timer here. */}
          <span ref={setDictationSlot} className="contents" />
          {sendPending ? (
            <span role="status" className="shrink-0 px-2 text-xs text-fg-subtle">
              Sending message…
            </span>
          ) : null}
          <button
            type="button"
            aria-label="Send message"
            onClick={send}
            disabled={
              (text.trim().length === 0 && intents.length === 0) ||
              disabled ||
              sendPending ||
              missingImages
            }
            tabIndex={-1}
            className="sr-only"
          >
            Send
          </button>
          <div
            className={
              resting
                ? 'flex shrink-0 items-center gap-0.5'
                : 'ms-auto flex shrink-0 items-center gap-0.5 self-end'
            }
          >
            <div ref={setStashAnchor} className={resting || dictating ? 'hidden' : 'relative'}>
              <motion.button
                key={`stash-pulse-${stashedPulse}`}
                type="button"
                aria-label={`Prompt stash (${stash.length})${recoveries.length > 0 ? ` · ${recoveries.length} saved message${recoveries.length === 1 ? '' : 's'}` : ''}`}
                aria-haspopup="menu"
                aria-expanded={stashOpen}
                title={
                  recoveries.length > 0
                    ? `${recoveries.length} saved message${recoveries.length === 1 ? '' : 's'} — open to restore`
                    : 'Stash this prompt (Mod+S) or reuse a stashed one'
                }
                onClick={() => setStashOpen((o) => !o)}
                animate={stashedPulse > 0 ? { scale: [1, 1.25, 1] } : undefined}
                transition={{ duration: 0.35, ease: 'easeOut' }}
                className={cx(iconButton, 'relative', stashOpen && iconButtonActive)}
              >
                <Bookmark size={16} strokeWidth={1.75} aria-hidden />
                {recoveries.length > 0 ? (
                  <span className={cx(countBadge, 'absolute -right-1.5 -top-1.5')}>
                    {recoveries.length}
                  </span>
                ) : null}
              </motion.button>
              <Popover open={stashOpen} onOpenChange={setStashOpen} anchor={stashAnchor}>
                <Popover.Content
                  side="top"
                  align="end"
                  bare
                  role="menu"
                  aria-label="Stashed prompts"
                  className="ari-scroll max-h-72 w-80 overflow-y-auto rounded-xl border border-border-strong bg-surface-1 p-1 shadow-3"
                >
                  {recoveries.length > 0 ? (
                    <>
                      <p className="px-2.5 py-1.5 text-xs text-fg-subtle">
                        Saved messages · restoring keeps your current draft here
                      </p>
                      {recoveries.map((message, index) => (
                        <div
                          key={message.id}
                          role="none"
                          className="group flex items-start gap-1 rounded-md"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            aria-label={`Restore ${message.delivery === 'uncertain' ? 'uncertain' : 'unsent'} message ${index + 1}`}
                            disabled={sendPending}
                            onClick={() => {
                              if (
                                onRecover?.(
                                  message,
                                  { text, files: [...images], images: intents },
                                  true,
                                )
                              )
                                setStashOpen(false)
                            }}
                            className="block w-full min-w-0 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-fg/6 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                          >
                            <span className="line-clamp-2 block whitespace-pre-wrap break-words text-fg">
                              {message.text || 'Saved context'}
                            </span>
                            {message.delivery === 'uncertain' ? (
                              <span className="mt-0.5 block text-xs text-fg-muted">
                                Delivery unknown · check the conversation before sending again
                              </span>
                            ) : null}
                            {(message.images?.length ?? message.files.length) > 0 ? (
                              <span className="mt-0.5 block text-xs text-fg-subtle">
                                {message.images?.length ?? message.files.length} image
                                {(message.images?.length ?? message.files.length) === 1 ? '' : 's'}
                              </span>
                            ) : null}
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove saved message ${index + 1}`}
                            disabled={sendPending || !sessionId}
                            onClick={() =>
                              sessionId &&
                              updateSessionDraftIntent(sessionId, (prev) => ({
                                ...prev,
                                recoveries: prev.recoveries.filter(
                                  (entry) => entry.id !== message.id,
                                ),
                              }))
                            }
                            className={cx(
                              rowAction,
                              'me-1 mt-1.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                            )}
                          >
                            <Trash2 size={13} strokeWidth={1.75} aria-hidden />
                          </button>
                        </div>
                      ))}
                    </>
                  ) : null}
                  {stash.length === 0 && recoveries.length === 0 ? (
                    <p className="px-3 py-5 text-center text-xs leading-relaxed text-fg-subtle">
                      Nothing stashed yet.
                      <br />
                      Press Mod+S to save the current draft.
                    </p>
                  ) : (
                    stash.map((entry) => (
                      <div
                        key={entry.savedAt}
                        className="group flex items-start gap-1 rounded-md"
                        role="none"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => restoreFromStash(entry)}
                          className="min-w-0 flex-1 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-fg/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                        >
                          <span className="line-clamp-2 block whitespace-pre-wrap break-words text-[13px] leading-snug text-fg">
                            {entry.text}
                          </span>
                          <span className="mt-0.5 block text-xs tabular-nums text-fg-subtle">
                            {new Date(entry.savedAt).toLocaleString()}
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-label="Remove from stash"
                          onClick={() => removeFromStash(entry)}
                          className={cx(
                            rowAction,
                            'me-1 mt-1.5 opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                          )}
                        >
                          <Trash2 size={13} strokeWidth={1.75} aria-hidden />
                        </button>
                      </div>
                    ))
                  )}
                </Popover.Content>
              </Popover>
            </div>
            {/* Dictation uses this PC's microphone, which a remote session cannot reach. */}
            {!remote ? (
              <SpeechButton
                key={sessionId ?? ''}
                captureTarget={() => {
                  const input = textareaRef.current
                  input?.focus()
                  return captureTextTarget(input)
                }}
                disabled={disabled}
                statusSlot={dictationSlot}
                onStateChange={setDictation}
              />
            ) : null}
            <SendStopButton
              running={running}
              onSend={send}
              onStop={onStop}
              canSend={!missingImages && (text.trim().length > 0 || intents.length > 0)}
              pending={sendPending}
              // The round button is finishing the dictation; only a live
              // turn's Stop stays beside it.
              stopOnly={dictating}
            />
          </div>
        </div>
      </div>
      {belowControls && <div className="pt-2">{belowControls}</div>}
      {inputIssue && (
        <p role="status" className="pt-2 text-xs text-fg-subtle">
          {inputIssue}
        </p>
      )}
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
      className="ari-composer-mention-overlay pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-[18px] pt-4 leading-relaxed text-fg [scrollbar-gutter:stable]"
    >
      {parts}
    </div>
  )
})

/** One of the round button's two stacked glyphs. */
const swapGlyph =
  'absolute inset-0 flex items-center justify-center transition-[opacity,transform] duration-[var(--ari-dur-fast)] ease-out motion-reduce:transition-none'

/**
 * The round button at the end of the control row. Idle it sends; while a turn
 * runs it stops, and a second circle appears beside it to queue the draft.
 * Only one of them is ink: the queue button when there is a draft to queue,
 * otherwise Stop.
 */
function SendStopButton({
  running,
  onSend,
  onStop,
  canSend,
  pending,
  stopOnly,
}: {
  running: boolean
  onSend: () => void
  onStop?: () => void
  canSend: boolean
  pending: boolean
  /** A dictation holds the row: offer no way to send, only to stop a live turn. */
  stopOnly: boolean
}) {
  if (stopOnly && !running) return null
  const queueable = running && canSend && !stopOnly
  return (
    <span className="ms-1.5 flex shrink-0 items-center gap-1.5">
      {queueable ? (
        <motion.button
          type="button"
          aria-label="Queue message"
          title="Queue message"
          onClick={onSend}
          disabled={pending}
          aria-busy={pending || undefined}
          whileTap={{ scale: 0.96 }}
          transition={transitions.morph}
          className={roundButton('ink')}
        >
          <ArrowUp size={17} strokeWidth={2} aria-hidden />
        </motion.button>
      ) : null}
      <motion.button
        type="button"
        aria-label={running ? 'Stop' : 'Send'}
        title={running ? 'Stop' : 'Send'}
        onClick={() => (running ? onStop?.() : onSend())}
        disabled={!running && (!canSend || pending)}
        aria-busy={!running && pending ? true : undefined}
        whileTap={{ scale: 0.96 }}
        transition={transitions.morph}
        className={roundButton(running ? (queueable ? 'wash' : 'ink') : canSend ? 'ink' : 'idle')}
      >
        {/* Both glyphs stay mounted and crossfade in CSS. An exit animation
            interrupted by a quick start/stop (or a backgrounded window) used
            to leave the square and the arrow stuck half-drawn on each other. */}
        <span
          aria-hidden
          data-glyph="stop"
          className={cx(swapGlyph, running ? 'scale-100 opacity-100' : 'scale-75 opacity-0')}
        >
          <Square size={11} fill="currentColor" />
        </span>
        <span
          aria-hidden
          data-glyph="send"
          className={cx(swapGlyph, running ? 'scale-75 opacity-0' : 'scale-100 opacity-100')}
        >
          <ArrowUp size={17} strokeWidth={2} />
        </span>
      </motion.button>
    </span>
  )
}
