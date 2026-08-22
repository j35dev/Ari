import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Skeleton } from '@ari/ui/skeleton'
import { useVirtualizer } from './use-virtualizer'
import { splitBlocks } from './splitBlocks'
import { groupBlocks } from './groupBlocks'
import { MarkdownBlock } from './MarkdownBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock, ToolResultBlock } from './ToolBlocks'
import { ToolActivityGroup } from './ToolActivityGroup'
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
}: {
  sessionId: string
  messages: Message[]
  loading?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  const rows = useMemo(() => groupBlocks(splitBlocks(messages)), [messages])

  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => 64,
    getScrollElement: () => scrollRef.current,
    overscan: 6,
  })

  // Stick-to-bottom: follow new content while pinned; expose jump pill otherwise.
  useEffect(() => {
    if (atBottom) {
      virtualizer.scrollToBottom('auto')
    }
  }, [rows.length, atBottom, virtualizer])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    setAtBottom(distance <= REENGAGE_BAND_PX)
  }

  const measureElement = useCallback(
    (node: HTMLElement | null): void => virtualizer.measureElement(node),
    [virtualizer],
  )

  return (
    <div className="relative h-full">
      <h2 className="sr-only">Messages</h2>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Conversation transcript"
        aria-live="polite"
        className="ari-scroll h-full overflow-y-auto px-4 py-4"
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
                ) : row.kind === 'markdown' ? (
                  row.role === 'user' ? (
                    <UserBubble text={row.text ?? ''} />
                  ) : (
                    <MarkdownBlock text={row.text ?? ''} />
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

        {!loading && rows.length === 0 ? (
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
    </div>
  )
}

/** Right-aligned user message bubble (Zeron style). */
function UserBubble({ text }: { text: string }) {
  return (
    <div className="my-2 flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-surface-2 px-3.5 py-2 text-sm leading-relaxed text-fg">
        {text}
      </div>
    </div>
  )
}
