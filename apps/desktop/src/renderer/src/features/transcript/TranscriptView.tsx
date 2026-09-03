import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from 'react'
import { Check, Copy, Pencil } from 'lucide-react'
import { Skeleton } from '@ari/ui/skeleton'
import { pinnedAfterScroll } from './transcript-pin'
import { splitBlocks } from './splitBlocks'
import { groupBlocks, isSingleStepGroup } from './groupBlocks'
import { MarkdownBlock } from './MarkdownBlock'
import { MessageFooter } from './MessageFooter'
import { ThinkingBlock } from './ThinkingBlock'
import { ErrorNote } from './ErrorNote'
import { ToolActivityGroup, ToolStep } from './ToolActivityGroup'
import { TurnDiffCard } from './TurnDiffCard'
import { MessageRail, type MessageRailEntry } from './MessageRail'
import { attachmentDataUrl } from './attachment-urls'
import type { ToolGroupRow, TranscriptImage, TranscriptRow } from './types'
import type { Message } from '@ari/contracts/message'

/** Rough characters per rendered line at the transcript's 48rem measure. */
const CHARS_PER_LINE = 90
const LINE_HEIGHT_PX = 22

/**
 * Fallback height for `contain-intrinsic-size` before a row has been painted.
 * `auto` remembers the last real size so off-screen rows do not collapse when
 * `content-visibility: auto` skips them.
 */
function estimateRowSize(row: TranscriptRow): number {
  if (row.kind === 'tool-group' || row.kind === 'turn-diff') return 40
  if (row.kind === 'tool-call' || row.kind === 'tool-result') return 48
  if (row.kind === 'image') return 96
  const text = row.text ?? ''
  if (text.length === 0) return 32
  let lines = 0
  for (const paragraph of text.split('\n')) {
    lines += Math.max(1, Math.ceil(paragraph.length / CHARS_PER_LINE))
  }
  return row.kind === 'thinking' ? 36 : lines * LINE_HEIGHT_PX + 16
}

/** Hover preview text for a rail entry: prompt text, or image filenames. */
function railText(row: TranscriptRow): string {
  if (row.kind === 'image') {
    return row.images?.map((image) => image.name).join(', ') || 'attached image'
  }
  if (row.kind === 'markdown') return row.text ?? ''
  return ''
}

function scrollToBottom(el: HTMLElement, behavior: ScrollBehavior): void {
  const top = Math.max(0, el.scrollHeight - el.clientHeight)
  if (typeof el.scrollTo === 'function') el.scrollTo({ top, left: 0, behavior })
  else el.scrollTop = top
}

/** Placeholder row widths for the initial-load skeleton (M13.3: no spinners >300ms). */
const LOADING_ROW_WIDTHS = ['92%', '78%', '85%', '64%'] as const

/**
 * Transcript in one native-scrolling document. Rows stay in flow — windowing
 * them as absolutely positioned segments made long sessions hitch and eat
 * wheel gestures every time a block mounted at a new height.
 */
export function TranscriptView({
  sessionId,
  messages,
  loading = false,
  turnDiffs,
  onEditUserMessage,
  onRegenerate,
  regenerateDisabled = false,
  header,
  onDiffComment,
  working,
}: {
  sessionId: string
  messages: Message[]
  loading?: boolean
  /** Settled turns' unified diffs (turnId → diffText); cards render inline. */
  turnDiffs?: Readonly<Record<string, string>>
  /** Called with a user bubble's text when its edit action fires (M19.4). */
  onEditUserMessage?: (text: string) => void
  /** Regenerate the last turn by resending the last user prompt (M19.4). */
  onRegenerate?: () => void
  /** Disables the regenerate control — true while a turn runs. */
  regenerateDisabled?: boolean
  /** Surface pinned above the transcript (plan panel); scrolls away with it. */
  header?: React.ReactNode
  /** Review-note loop (M21.1): inline diff comments flow to the composer. */
  onDiffComment?: (comment: { path: string; line: number | null; text: string }) => void
  /** Live working indicator, rendered where the next assistant reply will land. */
  working?: React.ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const lastScrollTopRef = useRef<number | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)

  const rows = useMemo(
    () => groupBlocks(splitBlocks(messages), turnDiffs),
    [messages, turnDiffs],
  )

  // Message rail (T3 minimap): one entry per user bubble row, with its row
  // index for jump-scrolling. Image-only prompts have no markdown row, so
  // their thumbnail row carries the entry instead. Hidden until two prompts
  // exist to navigate.
  const railEntries = useMemo<MessageRailEntry[]>(
    () =>
      rows
        .map((row, index) => ({ row, index }))
        .filter(
          ({ row }) =>
            (row.kind === 'markdown' || row.kind === 'image') && row.role === 'user',
        )
        .map(({ row, index }) => ({ key: String(index), text: railText(row) })),
    [rows],
  )
  const [activeRailKey, setActiveRailKey] = useState<string | null>(null)

  // Regenerate (M19.4) attaches to the newest assistant message only, so the
  // control reads as "redo this answer", not mid-history rewriting.
  const lastAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m && m.role === 'assistant') return m.id
    }
    return null
  }, [messages])

  const updateActiveRailKey = useCallback((): void => {
    const el = scrollRef.current
    if (el === null || railEntries.length < 2) return
    const anchor = el.scrollTop + el.clientHeight * 0.25
    let active: string | null = null
    for (const { key } of railEntries) {
      const node = el.querySelector(`[data-index="${key}"]`)
      if (!(node instanceof HTMLElement)) continue
      if (node.offsetTop <= anchor) active = key
      else break
    }
    setActiveRailKey((prev) => (prev === active ? prev : active))
  }, [railEntries])

  const handleRailJump = useCallback((key: string) => {
    const scroller = scrollRef.current
    const node = scroller?.querySelector(`[data-index="${key}"]`)
    if (!scroller || !(node instanceof HTMLElement)) return
    atBottomRef.current = false
    setAtBottom(false)
    scroller.scrollTo({ top: Math.max(0, node.offsetTop - 12), left: 0, behavior: 'smooth' })
  }, [])

  const hasWorking = Boolean(working)

  // Follow the tail while pinned. Observe the column so Shiki/code-fence
  // growth still sticks without a virtualizer measurement loop.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const inner = innerRef.current
    if (!scroller || !inner) return
    const follow = (): void => {
      if (!atBottomRef.current) return
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      if (Math.abs(scroller.scrollTop - max) <= 1) return
      scrollToBottom(scroller, 'auto')
    }
    follow()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(follow)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [rows, atBottom, hasWorking])

  const handleWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (event.deltaY >= 0 || !atBottomRef.current) return
    atBottomRef.current = false
    setAtBottom(false)
  }

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const previous = lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop
    const scrolledDown = previous !== null && el.scrollTop > previous
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const pinned = pinnedAfterScroll({
      wasPinned: atBottomRef.current,
      distanceFromBottom: distance,
      scrolledDown,
    })
    atBottomRef.current = pinned
    setAtBottom(pinned)
    updateActiveRailKey()
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <h2 className="sr-only">Messages</h2>
      {header}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        role="log"
        aria-label="Conversation transcript"
        aria-live="polite"
        className="ari-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4"
        data-session={sessionId}
      >
        <div ref={innerRef} className="mx-auto max-w-3xl">
          {rows.map((row, index) => (
            <TranscriptRowView
              key={row.key}
              row={row}
              index={index}
              lastAssistantMessageId={lastAssistantMessageId}
              onEditUserMessage={onEditUserMessage}
              onRegenerate={onRegenerate}
              regenerateDisabled={regenerateDisabled}
              onDiffComment={onDiffComment}
            />
          ))}
        </div>

        {loading && rows.length === 0 ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-4" aria-hidden="true">
            {LOADING_ROW_WIDTHS.map((width) => (
              <Skeleton key={width} h={14} style={{ width }} />
            ))}
          </div>
        ) : null}

        {working ? (
          <div className="mx-auto mt-3 max-w-3xl px-1" aria-live="polite">
            {working}
          </div>
        ) : null}

        {!loading && rows.length === 0 && !working ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
            No messages yet — say hello.
          </div>
        ) : null}
      </div>

      {!atBottom && rows.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            const el = scrollRef.current
            atBottomRef.current = true
            setAtBottom(true)
            if (el) scrollToBottom(el, 'smooth')
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-1 text-xs font-medium text-fg-on-accent shadow-2 transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          Jump to latest ↓
        </button>
      ) : null}

      {railEntries.length >= 2 ? (
        <MessageRail entries={railEntries} activeKey={activeRailKey} onJump={handleRailJump} />
      ) : null}
    </div>
  )
}

/**
 * A tool burst renders as its bare step row when it holds a single call and
 * no reasoning; anything larger keeps the collapsible activity wrapper.
 */
function ToolGroupView({ row }: { row: ToolGroupRow }) {
  const call = row.calls.length === 1 && isSingleStepGroup(row) ? row.calls[0] : undefined
  if (call === undefined) return <ToolActivityGroup row={row} />
  return (
    <ToolStep call={call} result={call.callId ? row.resultsByCallId.get(call.callId) : undefined} />
  )
}

function TranscriptRowView({
  row,
  index,
  lastAssistantMessageId,
  onEditUserMessage,
  onRegenerate,
  regenerateDisabled,
  onDiffComment,
}: {
  row: TranscriptRow
  index: number
  lastAssistantMessageId: string | null
  onEditUserMessage?: (text: string) => void
  onRegenerate?: () => void
  regenerateDisabled: boolean
  onDiffComment?: (comment: { path: string; line: number | null; text: string }) => void
}) {
  return (
    <div
      data-index={index}
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: `auto ${estimateRowSize(row)}px`,
      }}
    >
      {row.kind === 'tool-group' ? (
        <ToolGroupView row={row} />
      ) : row.kind === 'turn-diff' ? (
        <TurnDiffCard turnId={row.turnId} diffText={row.diffText} onComment={onDiffComment} />
      ) : row.kind === 'image' ? (
        <UserImageRow images={row.images ?? []} right={row.role === 'user'} />
      ) : row.kind === 'markdown' ? (
        row.role === 'user' ? (
          <UserBubble text={row.text ?? ''} onEdit={onEditUserMessage} />
        ) : (
          <div>
            <MarkdownBlock text={row.text ?? ''} />
            {row.isLastOfMessage && row.messageId ? (
              <MessageFooter
                message={{
                  id: row.messageId,
                  sessionId: '',
                  turnId: null,
                  role: 'assistant',
                  parts: [{ type: 'text', text: row.text ?? '' }],
                  createdAt: row.messageCreatedAt ?? Date.now(),
                }}
                onRegenerate={
                  onRegenerate && row.messageId === lastAssistantMessageId ? onRegenerate : undefined
                }
                actionDisabled={regenerateDisabled}
              />
            ) : null}
          </div>
        )
      ) : row.kind === 'error-note' ? (
        <ErrorNote text={row.text ?? ''} />
      ) : row.kind === 'thinking' ? (
        <ThinkingBlock text={row.text ?? ''} />
      ) : null}
    </div>
  )
}

/**
 * Staged-image thumbnails for a message's image row, stacked above its text
 * bubble. Bytes load lazily from the main process (`attachments.read`,
 * cached per id); a missing file renders its filename, never a broken image.
 */
function UserImageRow({ images, right }: { images: TranscriptImage[]; right: boolean }) {
  const [urls, setUrls] = useState<Record<string, string | null>>({})

  useEffect(() => {
    let cancelled = false
    void Promise.all(
      images.map(async (image) => {
        const url = await attachmentDataUrl(image.attachmentId)
        if (!cancelled) setUrls((prev) => ({ ...prev, [image.attachmentId]: url }))
      }),
    )
    return () => {
      cancelled = true
    }
  }, [images])

  if (images.length === 0) return null
  return (
    <div className={`my-2 flex ${right ? 'justify-end' : 'justify-start'}`}>
      <div
        role="list"
        aria-label="Attached images"
        className="flex max-w-[85%] flex-wrap gap-2"
      >
        {images.map((image) => {
          const url = urls[image.attachmentId]
          return (
            <div
              key={image.attachmentId}
              role="listitem"
              title={image.name}
              className="h-20 w-20 overflow-hidden rounded-lg border border-border bg-surface-1"
            >
              {url === undefined ? (
                <div
                  className="h-full w-full animate-pulse bg-surface-2"
                  aria-label={`Loading ${image.name}`}
                />
              ) : url === null ? (
                <div className="flex h-full w-full items-center justify-center px-1 text-center text-2xs text-fg-subtle">
                  {image.name}
                </div>
              ) : (
                <img src={url} alt={image.name} className="h-full w-full object-cover" />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Right-aligned user message bubble (Zeron style) with hover copy and edit
 * affordances. Edit hands the bubble's text back via `onEdit`, which fills
 * the composer for an edit-and-resend flow.
 */
function UserBubble({ text, onEdit }: { text: string; onEdit?: (text: string) => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // clipboard unavailable — affordance stays silent
    }
  }
  return (
    <div className="group my-2 flex justify-end">
      <div className="flex max-w-[85%] items-end gap-1">
        {onEdit ? (
          <button
            type="button"
            onClick={() => onEdit(text)}
            aria-label="Edit message"
            title="Edit and resend"
            className="mb-1 shrink-0 rounded-sm p-0.5 text-fg-subtle opacity-0 transition-opacity duration-150 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
          >
            <Pencil size={12} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? 'Copied' : 'Copy message'}
          className="mb-1 shrink-0 rounded-sm p-0.5 text-fg-subtle opacity-0 transition-opacity duration-150 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <div className="whitespace-pre-wrap break-words rounded-xl bg-surface-2 px-3.5 py-2 text-sm leading-relaxed text-fg">
          {text}
        </div>
      </div>
    </div>
  )
}
