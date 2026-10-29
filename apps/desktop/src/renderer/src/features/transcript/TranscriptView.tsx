import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type WheelEvent,
} from 'react'
import { flushSync } from 'react-dom'
import { Check, Copy, Download, Maximize2, Pencil, X } from 'lucide-react'
import { Dialog } from '@ari/ui/dialog'
import { Skeleton } from '@ari/ui/skeleton'
import { pinnedAfterScroll } from './transcript-pin'
import { splitBlocks } from './splitBlocks'
import { groupBlocks, rowTurnId } from './groupBlocks'
import { MarkdownBlock } from './MarkdownBlock'
import { MessageFooter } from './MessageFooter'
import { ThinkingBlock } from './ThinkingBlock'
import { ErrorNote } from './ErrorNote'
import { NoticeNote } from './NoticeNote'
import { ActivityBurst } from './ActivityBurst'
import { TurnDiffCard } from './TurnDiffCard'
import { MessageRail, type MessageRailEntry } from './MessageRail'
import { DelegationCard } from './DelegationCard'
import { insertDelegationRows } from './delegation-rows'
import { useLazyRows } from './use-lazy-rows'
import { attachmentDataUrl } from './attachment-urls'
import type {
  DelegatedChild,
  GroupedRow,
  TranscriptBlock,
  TranscriptImage,
  TranscriptRow,
} from './types'
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
  const known = estimates.get(row)
  if (known !== undefined) return known
  const size = estimateUncached(row)
  estimates.set(row, size)
  return size
}

/** Rows keep their identity across flushes, so each is estimated once. */
const estimates = new WeakMap<TranscriptRow, number>()

function estimateUncached(row: TranscriptRow): number {
  if (row.kind === 'tool-group') return 30
  if (row.kind === 'turn-diff') return 40
  if (row.kind === 'delegation') return 30 * row.children.length
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

/**
 * A wake Ari wrote for the parent agent. It stays in the journal so the model
 * can read it, and stays out of the conversation.
 */
function isAgentWake(message: Message): boolean {
  const kind = message.origin?.kind
  return kind === 'completion' || kind === 'question'
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
 * wheel gestures every time a block mounted at a new height. A long history
 * mounts progressively instead (see `useLazyRows`): rows far from the
 * viewport hold their estimated height until the reader nears them, and
 * the browser's scroll anchoring absorbs the difference.
 */
export function TranscriptView({
  sessionId,
  messages,
  loading = false,
  turnDiffs,
  onEditUserMessage,
  onRegenerate,
  regenerateDisabled = false,
  running = false,
  header,
  onDiffComment,
  working,
  activity,
  delegations,
  sessionTitle,
  onOpenSession,
  onTurnInView,
  hidden = false,
}: {
  sessionId: string
  messages: Message[]
  /**
   * Called with a turn's id once its last row comes near the viewport, so
   * per-turn work (the diff card query) runs for turns the reader can see
   * rather than for every turn in history. May repeat for the same turn.
   */
  onTurnInView?: (turnId: string) => void
  activity?: React.ReactNode
  /** Children this session delegated to; each renders as a task card where it was spawned. */
  delegations?: readonly DelegatedChild[]
  /** Current title of another session, for attributing messages it sent. */
  sessionTitle?: (id: string) => string | undefined
  onOpenSession?: (id: string) => void
  loading?: boolean
  /** Settled turns' unified diffs (turnId → diffText); cards render inline. */
  turnDiffs?: Readonly<Record<string, string>>
  /** Called with a user bubble's text when its edit action fires (M19.4). */
  onEditUserMessage?: (text: string) => void
  /** Regenerate the last turn by resending the last user prompt (M19.4). */
  onRegenerate?: () => void
  /** Disables the regenerate control — true while a turn runs. */
  regenerateDisabled?: boolean
  /**
   * True while a turn is streaming. The turn works its way down the transcript,
   * so the last row is the one it is on, and it is the only row that renders
   * live — see `ActivityBurst`. Defaults to settled.
   */
  running?: boolean
  /** Surface pinned above the transcript (plan panel); scrolls away with it. */
  header?: React.ReactNode
  /** Review-note loop (M21.1): inline diff comments flow to the composer. */
  onDiffComment?: (comment: { path: string; line: number | null; text: string }) => void
  /** Live working indicator, rendered where the next assistant reply will land. */
  working?: React.ReactNode
  /**
   * Kept mounted off screen. Rows that land meanwhile are not announced: the
   * entrance would wait for the view to show and then play for all of them.
   */
  hidden?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const lastScrollTopRef = useRef<number | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  // Where the reader left off when scrolled up; null while pinned to the tail.
  // Hiding a scroller resets its offset, so this is what showing it restores.
  const readingAtRef = useRef<{ sessionId: string; top: number } | null>(null)

  // Each pass is handed the last one's output, so rows a flush left alone keep
  // their identity and the memoized row view skips them. Delegation cards are
  // placed among the grouped rows afterwards and leave those rows untouched.
  const blocksRef = useRef<TranscriptBlock[]>([])
  const groupedRef = useRef<GroupedRow[]>([])
  const rows = useMemo<TranscriptRow[]>(() => {
    const visible = messages.some(isAgentWake)
      ? messages.filter((message) => !isAgentWake(message))
      : messages
    blocksRef.current = splitBlocks(visible, blocksRef.current)
    groupedRef.current = groupBlocks(blocksRef.current, turnDiffs, groupedRef.current)
    return insertDelegationRows(groupedRef.current, delegations ?? [])
  }, [messages, turnDiffs, delegations])
  // A task card sits below the burst that spawned it, so while a turn waits on
  // its children the burst is no longer the last row. It is still the row the
  // turn is on, and the one that reads as live.
  const activeIndex = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i]?.kind !== 'delegation') return i
    return -1
  }, [rows])
  // The last row of each turn, keyed by row key: where its diff card attaches.
  const turnEnds = useMemo(() => {
    const ends = new Map<string, string>()
    let lastKey: string | null = null
    let lastTurn: string | null = null
    for (const row of rows) {
      if (row.kind === 'delegation') continue
      const turn = rowTurnId(row)
      if (lastKey !== null && lastTurn !== null && turn !== lastTurn) ends.set(lastKey, lastTurn)
      lastKey = row.key
      lastTurn = turn
    }
    if (lastKey !== null && lastTurn !== null) ends.set(lastKey, lastTurn)
    return ends
  }, [rows])
  const turnEndsSignature = useMemo(() => [...turnEnds.values()].join(' '), [turnEnds])
  const onTurnInViewRef = useRef(onTurnInView)
  onTurnInViewRef.current = onTurnInView
  const watchesTurns = onTurnInView !== undefined
  const seenRowsRef = useRef(new Set<string>())
  const freshRowsRef = useRef(new Set<string>())
  const historyLoadedRef = useRef(false)
  const [, settleEntrance] = useReducer((count: number) => count + 1, 0)

  // Message rail (T3 minimap): one entry per user bubble row, with its row
  // index for jump-scrolling. Image-only prompts have no markdown row, so
  // their thumbnail row carries the entry instead. Hidden until two prompts
  // exist to navigate.
  const railRef = useRef<MessageRailEntry[]>([])
  const railEntries = useMemo<MessageRailEntry[]>(() => {
    const next = rows
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row }) =>
          (row.kind === 'markdown' || row.kind === 'image') &&
          row.role === 'user' &&
          // A delegation update is Ari reporting back, not a prompt to jump to.
          row.origin?.kind !== 'completion',
      )
      .map(({ row, index }) => ({ key: String(index), text: railText(row) }))
    // The rail only changes when a prompt is added; keep the array stable
    // through the streaming flushes in between.
    const before = railRef.current
    const same =
      before.length === next.length &&
      next.every((entry, i) => entry.key === before[i]?.key && entry.text === before[i]?.text)
    if (!same) railRef.current = next
    return railRef.current
  }, [rows])
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

  // Rail rows are looked up once per rail change, not per scroll event.
  const railNodesRef = useRef<{ entries: MessageRailEntry[]; nodes: (HTMLElement | null)[] }>({
    entries: [],
    nodes: [],
  })
  const updateActiveRailKey = useCallback((): void => {
    const el = scrollRef.current
    if (el === null || railEntries.length < 2) return
    const cache = railNodesRef.current
    if (cache.entries !== railEntries || cache.nodes.some((node) => node?.isConnected === false)) {
      cache.entries = railEntries
      cache.nodes = railEntries.map(({ key }) => {
        const node = el.querySelector(`[data-index="${key}"]`)
        return node instanceof HTMLElement ? node : null
      })
    }
    const anchor = el.scrollTop + el.clientHeight * 0.25
    // Prompts sit in document order, so the active one is found by bisection.
    let low = 0
    let high = cache.nodes.length - 1
    let active: string | null = null
    while (low <= high) {
      const mid = (low + high) >> 1
      const node = cache.nodes[mid]
      if (node != null && node.offsetTop > anchor) {
        high = mid - 1
      } else {
        if (node != null) active = railEntries[mid]?.key ?? null
        low = mid + 1
      }
    }
    setActiveRailKey((prev) => (prev === active ? prev : active))
  }, [railEntries])
  const railFrameRef = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (railFrameRef.current !== null) cancelAnimationFrame(railFrameRef.current)
    },
    [],
  )

  const lazyRows = useLazyRows(scrollRef, rows, sessionId, (index) => {
    const row = rows[index]
    return row === undefined ? 0 : estimateRowSize(row)
  })
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const mountRow = lazyRows.mount

  const handleRailJump = useCallback(
    (key: string) => {
      const target = rowsRef.current[Number(key)]
      // A row still held as a placeholder mounts first, so the jump lands on
      // its real top rather than its estimate.
      if (target !== undefined) flushSync(() => mountRow(target.key))
      const scroller = scrollRef.current
      const node = scroller?.querySelector(`[data-index="${key}"]`)
      if (!scroller || !(node instanceof HTMLElement)) return
      atBottomRef.current = false
      setAtBottom(false)
      scroller.scrollTo({ top: Math.max(0, node.offsetTop - 12), left: 0, behavior: 'smooth' })
    },
    [mountRow],
  )

  const hasWorking = Boolean(working)
  // Only a turn seen running here may announce that it finished.
  const ranHereRef = useRef(false)
  if (running) ranHereRef.current = true

  /**
   * Lands a scroller that has just come into view: back where the reader left
   * off when they had scrolled up, otherwise on the tail. A `display:none`
   * pane restores at scrollTop 0, which would show the jump pill on a long
   * transcript and lose their place.
   */
  const land = useCallback(
    (scroller: HTMLElement): void => {
      lastScrollTopRef.current = null
      const readingAt = readingAtRef.current
      if (readingAt?.sessionId === sessionId) {
        scroller.scrollTop = readingAt.top
        atBottomRef.current = false
        setAtBottom(false)
        return
      }
      atBottomRef.current = true
      setAtBottom(true)
      scrollToBottom(scroller, 'auto')
    },
    [sessionId],
  )

  // First mount, a session switch, and every time a kept-alive view is shown
  // again: its effects re-run then, after the hidden stretch reset the scroller.
  const landedSessionRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (landedSessionRef.current !== sessionId) ranHereRef.current = false
    landedSessionRef.current = sessionId
    const scroller = scrollRef.current
    if (scroller) land(scroller)
  }, [sessionId, land])

  // Split-view zoom (and any other `display:none`) collapses the scroller
  // to height 0 and resets scrollTop. When it comes back, land it again.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    let lastHeight = scroller.clientHeight
    const observer = new ResizeObserver(() => {
      const height = scroller.clientHeight
      const appeared = lastHeight === 0 && height > 0
      lastHeight = height
      if (height === 0) {
        lastScrollTopRef.current = null
        return
      }
      if (appeared) land(scroller)
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [land])

  // Jumps rather than glides: a smooth scroll restarted on every streamed
  // flush kept the compositor busy and fired a storm of scroll events.
  const followTail = useCallback((): void => {
    const scroller = scrollRef.current
    if (!scroller || !atBottomRef.current) return
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    if (Math.abs(scroller.scrollTop - max) <= 1) return
    scrollToBottom(scroller, 'auto')
  }, [])

  // Follow the tail while pinned. Observe the column so streamed rows,
  // Shiki and code-fence growth stick after layout has already run, instead
  // of forcing one from a layout effect on every flush. The observer lives
  // for the life of the view: rebuilding it on every streaming flush
  // re-observed the whole column several times a second.
  useLayoutEffect(() => {
    const inner = innerRef.current
    if (!inner || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(followTail)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [followTail])

  useEffect(() => {
    const inner = innerRef.current
    if (!inner || !watchesTurns || turnEndsSignature.length === 0) return
    const nodes = inner.querySelectorAll<HTMLElement>('[data-turn-end]')
    const report = (node: Element): void => {
      const turnId = node instanceof HTMLElement ? node.dataset.turnEnd : undefined
      if (turnId) onTurnInViewRef.current?.(turnId)
    }
    if (typeof IntersectionObserver === 'undefined') {
      nodes.forEach(report)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          observer.unobserve(entry.target)
          report(entry.target)
        }
      },
      { root: scrollRef.current, rootMargin: '600px 0px' },
    )
    nodes.forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [watchesTurns, turnEndsSignature])

  // The working indicator sits outside the observed column, and re-pinning
  // has to land on the tail at once rather than at the next resize.
  useLayoutEffect(followTail, [followTail, atBottom, hasWorking])

  const handleWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (event.deltaY >= 0 || !atBottomRef.current) return
    atBottomRef.current = false
    setAtBottom(false)
  }

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    // Hidden panes (`display:none`) report no box; forget the last offset so
    // the next sample is not mistaken for a user scroll-up to the top.
    if (el.clientHeight === 0) {
      lastScrollTopRef.current = null
      return
    }
    const previous = lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop
    const scrolledDown = previous !== null && el.scrollTop > previous
    const scrolledUp = previous !== null && el.scrollTop < previous
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const pinned = pinnedAfterScroll({
      wasPinned: atBottomRef.current,
      distanceFromBottom: distance,
      scrolledDown,
      scrolledUp,
    })
    atBottomRef.current = pinned
    readingAtRef.current = pinned ? null : { sessionId, top: el.scrollTop }
    setAtBottom(pinned)
    // The rail reads row offsets: once per frame however many events fire.
    if (railFrameRef.current === null && railEntries.length >= 2) {
      railFrameRef.current = requestAnimationFrame(() => {
        railFrameRef.current = null
        updateActiveRailKey()
      })
    }
  }

  // Rows that arrive after the transcript has loaded announce themselves; the
  // history a session opens with does not, or a long transcript would animate
  // every row at once. Sticky, so a re-render mid-entrance (streaming
  // re-renders constantly) does not drop the class and cut the motion short.
  const seenRows = seenRowsRef.current
  const freshRows = freshRowsRef.current
  for (const row of rows) {
    if (historyLoadedRef.current && !hidden && !seenRows.has(row.key)) freshRows.add(row.key)
    seenRows.add(row.key)
  }
  if (!loading) historyLoadedRef.current = true

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
        // Not a live region: a screen reader would re-announce every streamed
        // flush. The working status below announces instead.
        aria-live="off"
        className="ari-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4"
        data-session={sessionId}
      >
        <div ref={innerRef} className="mx-auto max-w-3xl">
          {rows.map((row, index) => (
            <div
              key={row.key}
              className={freshRows.has(row.key) ? 'ari-enter-rise' : undefined}
              data-turn-end={turnEnds.get(row.key)}
              // Once it has played, the class comes off: a pane shown again
              // after being hidden restarts CSS animations, and every row that
              // arrived live would rise at once.
              onAnimationEnd={(event) => {
                if (event.target !== event.currentTarget) return
                if (freshRows.delete(row.key)) settleEntrance()
              }}
            >
              {lazyRows.isMounted(row.key) ? (
                <TranscriptRowView
                  row={row}
                  index={index}
                  sessionTitle={sessionTitle}
                  onOpenSession={onOpenSession}
                  onEditUserMessage={onEditUserMessage}
                  // Only the newest answer's footer row regenerates; handing the
                  // callback to every row would re-render all of them whenever
                  // it changes, which is every flush.
                  onRegenerate={
                    row.kind === 'markdown' &&
                    row.isLastOfMessage === true &&
                    row.messageId === lastAssistantMessageId
                      ? onRegenerate
                      : undefined
                  }
                  regenerateDisabled={regenerateDisabled}
                  active={running && index === activeIndex}
                  onDiffComment={onDiffComment}
                />
              ) : (
                <RowPlaceholder row={row} index={index} observe={lazyRows.observe} />
              )}
            </div>
          ))}
        </div>

        {activity}
        {loading && rows.length === 0 ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-4" aria-hidden="true">
            {LOADING_ROW_WIDTHS.map((width) => (
              <Skeleton key={width} h={14} style={{ width }} />
            ))}
          </div>
        ) : null}

        <span className="sr-only" role="status">
          {running ? 'Agent is replying' : ranHereRef.current ? 'Reply finished' : ''}
        </span>

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
            readingAtRef.current = null
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

/** A row not mounted yet: its estimated height, watched for the viewport. */
const RowPlaceholder = memo(function RowPlaceholder({
  row,
  index,
  observe,
}: {
  row: TranscriptRow
  index: number
  observe: (element: HTMLElement | null) => (() => void) | undefined
}) {
  return (
    <div
      ref={observe}
      data-index={index}
      data-lazy-row={row.key}
      aria-hidden="true"
      style={{ height: estimateRowSize(row) }}
    />
  )
})

/**
 * Memoized: rows keep their identity across flushes (see `splitBlocks`), so a
 * streaming turn re-renders the row it is on and nothing above it.
 */
const TranscriptRowView = memo(function TranscriptRowView({
  row,
  index,
  onEditUserMessage,
  onRegenerate,
  regenerateDisabled,
  active,
  onDiffComment,
  sessionTitle,
  onOpenSession,
}: {
  row: TranscriptRow
  sessionTitle?: (id: string) => string | undefined
  onOpenSession?: (id: string) => void
  index: number
  onEditUserMessage?: (text: string) => void
  /** Present only on the newest answer's footer row. */
  onRegenerate?: () => void
  regenerateDisabled: boolean
  /** True when a running turn is on this row; only ever the last one. */
  active: boolean
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
        <ActivityBurst row={row} active={active} />
      ) : row.kind === 'turn-diff' ? (
        <TurnDiffCard turnId={row.turnId} diffText={row.diffText} onComment={onDiffComment} />
      ) : row.kind === 'delegation' ? (
        <DelegationCard row={row} onOpenSession={onOpenSession} />
      ) : row.kind === 'image' ? (
        <ImageRow images={row.images ?? []} right={row.role === 'user'} />
      ) : row.kind === 'markdown' ? (
        row.role === 'user' ? (
          <div>
            {row.origin?.kind === 'session' ? (
              <SenderLabel
                sessionId={row.origin.sessionId}
                title={sessionTitle?.(row.origin.sessionId)}
                onOpenSession={onOpenSession}
              />
            ) : null}
            <UserBubble
              text={row.text ?? ''}
              onEdit={row.origin?.kind === 'session' ? undefined : onEditUserMessage}
            />
          </div>
        ) : (
          <div>
            <MarkdownBlock text={row.text ?? ''} streaming={active} />
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
                onRegenerate={onRegenerate}
                actionDisabled={regenerateDisabled}
              />
            ) : null}
          </div>
        )
      ) : row.kind === 'error-note' ? (
        <ErrorNote text={row.text ?? ''} />
      ) : row.kind === 'notice' ? (
        <NoticeNote text={row.text ?? ''} />
      ) : row.kind === 'thinking' ? (
        <ThinkingBlock text={row.text ?? ''} />
      ) : null}
    </div>
  )
})

/**
 * Staged-image thumbnails for a message's image row, stacked above its text
 * bubble. Bytes load lazily from the main process (`attachments.read`,
 * cached per id); a missing file renders its filename, never a broken image.
 */
function ImageRow({ images, right }: { images: TranscriptImage[]; right: boolean }) {
  const [urls, setUrls] = useState<Record<string, string | null>>({})
  const [selected, setSelected] = useState<TranscriptImage | null>(null)

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
  const selectedUrl = selected === null ? null : urls[selected.attachmentId]
  return (
    <>
      <div className={`my-2 flex ${right ? 'justify-end' : 'justify-start'}`}>
        <div
          role="list"
          aria-label={right ? 'Attached images' : 'Generated images'}
          className="flex max-w-[85%] flex-wrap gap-2"
        >
          {images.map((image) => {
            const url = urls[image.attachmentId]
            const frame = right ? 'h-20 w-20 rounded-lg' : 'max-h-[28rem] max-w-full rounded-xl'
            return (
              <div
                key={image.attachmentId}
                role="listitem"
                title={image.name}
                className={`group relative overflow-hidden border border-border bg-surface-1 ${frame}`}
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
                  <button
                    type="button"
                    onClick={() => setSelected(image)}
                    aria-label={`Open ${image.name}`}
                    className={`relative block overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring ${frame}`}
                  >
                    <img
                      src={url}
                      alt={image.name}
                      className={
                        right
                          ? 'h-full w-full object-cover'
                          : 'max-h-[28rem] max-w-full object-contain'
                      }
                    />
                    <span className="absolute inset-0 flex items-center justify-center bg-surface-0/50 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                      <span className="flex items-center gap-1.5 rounded-md border border-border bg-surface-1/90 px-2.5 py-1.5 text-xs font-medium text-fg shadow-2">
                        <Maximize2 size={13} aria-hidden="true" />
                        Open
                      </span>
                    </span>
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <Dialog.Content size="lg" className="overflow-hidden bg-surface-0">
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-sm">{selected?.name ?? 'Image'}</Dialog.Title>
              <Dialog.Description className="sr-only">Full-size image preview</Dialog.Description>
            </div>
            {selected !== null && typeof selectedUrl === 'string' ? (
              <a
                href={selectedUrl}
                download={selected.name}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 text-xs font-medium text-fg transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                <Download size={13} aria-hidden="true" />
                Download
              </a>
            ) : null}
            <Dialog.Close
              aria-label="Close image preview"
              className="flex size-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              <X size={15} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-0 p-4">
            {selected !== null && typeof selectedUrl === 'string' ? (
              <img
                src={selectedUrl}
                alt={`Full-size ${selected.name}`}
                className="max-h-full max-w-full object-contain shadow-2"
              />
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog>
    </>
  )
}

/** Names the session a message came from, so it is not read as something typed here. */
function SenderLabel({
  sessionId,
  title,
  onOpenSession,
}: {
  sessionId: string
  title: string | undefined
  onOpenSession?: (id: string) => void
}) {
  const className = 'font-mono text-2xs text-fg-subtle'
  return (
    <p className="mt-2 text-right">
      {title !== undefined && onOpenSession ? (
        <button
          type="button"
          onClick={() => onOpenSession(sessionId)}
          className={`${className} rounded-sm transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring`}
        >
          From session {title}
        </button>
      ) : (
        <span className={className}>From {title ? `session ${title}` : 'another session'}</span>
      )}
    </p>
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
            className="mb-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle opacity-0 transition-[color,background-color,opacity] duration-150 hover:bg-surface-2 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
          >
            <Pencil size={12} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? 'Copied' : 'Copy message'}
          className="mb-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle opacity-0 transition-[color,background-color,opacity] duration-150 hover:bg-surface-2 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <div className="whitespace-pre-wrap break-words rounded-2xl border border-border/70 bg-surface-2/90 px-4 py-2.5 text-sm leading-relaxed text-fg shadow-sm">
          {text}
        </div>
      </div>
    </div>
  )
}
