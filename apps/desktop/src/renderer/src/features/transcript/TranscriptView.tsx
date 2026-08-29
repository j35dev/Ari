import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Pencil } from 'lucide-react'
import { Skeleton } from '@ari/ui/skeleton'
import { useVirtualizer } from './use-virtualizer'
import { splitBlocks } from './splitBlocks'
import { groupBlocks } from './groupBlocks'
import { MarkdownBlock } from './MarkdownBlock'
import { MessageFooter } from './MessageFooter'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock, ToolResultBlock } from './ToolBlocks'
import { ToolActivityGroup } from './ToolActivityGroup'
import { TurnDiffCard } from './TurnDiffCard'
import { MessageRail, type MessageRailEntry } from './MessageRail'
import type { Message } from '@ari/contracts/message'

const REENGAGE_BAND_PX = 70

/** Placeholder row widths for the initial-load skeleton (M13.3: no spinners >300ms). */
const LOADING_ROW_WIDTHS = ['92%', '78%', '85%', '64%'] as const

/**
 * Virtualized transcript: block-granular rows, dynamic measurement,
 * stick-to-bottom with a re-engage band (PLAN §6.5). Consecutive tool calls
 * collapse into single activity rows; user messages render as right-aligned
 * bubbles. While the initial load resolves it shows skeleton rows.
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
  const [atBottom, setAtBottom] = useState(true)

  const rows = useMemo(
    () => groupBlocks(splitBlocks(messages), turnDiffs),
    [messages, turnDiffs],
  )

  // Message rail (T3 minimap): one entry per user bubble row, with its row
  // index for jump-scrolling. Hidden until two prompts exist to navigate.
  const railEntries = useMemo<MessageRailEntry[]>(
    () =>
      rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row.kind === 'markdown' && row.role === 'user')
        .map(({ row, index }) => ({
          key: String(index),
          text: (row.kind === 'markdown' && (row.text ?? '')) || '',
        })),
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

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => 64,
    getScrollElement: () => scrollRef.current,
    overscan: 6,
  })

  // Offsets refresh each render; user rows are few so this is trivial.
  const railOffsets = useMemo(
    () =>
      railEntries.map((entry) => ({
        key: entry.key,
        start: virtualizer.getRowStart(Number(entry.key)),
      })),
    [railEntries, virtualizer, virtualizer.getVersion()],
  )

  const updateActiveRailKey = useCallback((): void => {
    const el = scrollRef.current
    if (el === null || railOffsets.length < 2) return
    const anchor = el.scrollTop + el.clientHeight * 0.25
    let active: string | null = null
    for (const { key, start } of railOffsets) {
      if (start <= anchor) active = key
      else break
    }
    setActiveRailKey((prev) => (prev === active ? prev : active))
  }, [railOffsets])

  const handleRailJump = useCallback(
    (key: string) => {
      setAtBottom(false)
      virtualizer.scrollToOffset(Math.max(0, virtualizer.getRowStart(Number(key)) - 12), 'smooth')
    },
    [virtualizer],
  )

  // Stick-to-bottom: follow new content while pinned; expose jump pill otherwise.
  useEffect(() => {
    if (atBottom) {
      virtualizer.scrollToBottom('auto')
    }
  }, [rows, atBottom, virtualizer])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    setAtBottom(distance <= REENGAGE_BAND_PX)
    updateActiveRailKey()
  }

  const measureElement = useCallback(
    (node: HTMLElement | null): void => virtualizer.measureElement(node),
    [virtualizer],
  )

  return (
    <div className="ari-reading-frost relative flex h-full min-h-0 flex-col">
      <h2 className="sr-only">Messages</h2>
      {header}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Conversation transcript"
        aria-live="polite"
        className="ari-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4"
        data-session={sessionId}
      >
        <div
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          className="mx-auto max-w-3xl"
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            if (!row) return null
            return (
              <div
                key={row.key}
                data-index={item.index}
                ref={measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row.kind === 'tool-group' ? (
                  <ToolActivityGroup row={row} />
                ) : row.kind === 'turn-diff' ? (
                  <TurnDiffCard turnId={row.turnId} diffText={row.diffText} onComment={onDiffComment} />
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
                            onRegenerate && row.messageId === lastAssistantMessageId
                              ? onRegenerate
                              : undefined
                          }
                          actionDisabled={regenerateDisabled}
                        />
                      ) : null}
                    </div>
                  )
                ) : row.kind === 'thinking' ? (
                  <ThinkingBlock text={row.text ?? ''} />
                ) : row.kind === 'tool-call' ? (
                  <ToolCallBlock block={row} />
                ) : (
                  <ToolResultBlock block={row} />
                )}
              </div>
            )
          })}
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
            setAtBottom(true)
            virtualizer.scrollToBottom('smooth')
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
