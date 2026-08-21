import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from './use-virtualizer'
import { splitBlocks } from './splitBlocks'
import { MarkdownBlock } from './MarkdownBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock, ToolResultBlock } from './ToolBlocks'
import type { Message } from '@ari/contracts/message'

const REENGAGE_BAND_PX = 70

/**
 * Virtualized transcript: block-granular rows, dynamic measurement,
 * stick-to-bottom with a re-engage band (PLAN §6.5).
 */
export function TranscriptView({
  sessionId,
  messages,
}: {
  sessionId: string
  messages: Message[]
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  const blocks = useMemo(() => splitBlocks(messages), [messages])

  const virtualizer = useVirtualizer({
    count: blocks.length,
    estimateSize: () => 64,
    getScrollElement: () => scrollRef.current,
    overscan: 6,
  })

  // Stick-to-bottom: follow new content while pinned; expose jump pill otherwise.
  useEffect(() => {
    if (atBottom) {
      virtualizer.scrollToBottom('auto')
    }
  }, [blocks.length, atBottom, virtualizer])

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
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="ari-scroll h-full overflow-y-auto px-4 py-4"
        data-session={sessionId}
      >
        <div
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          className="mx-auto max-w-3xl"
        >
          {virtualizer.getVirtualItems().map((item) => {
            const block = blocks[item.index]
            if (!block) return null
            return (
              <div
                key={block.key}
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
                {block.kind === 'markdown' ? <MarkdownBlock text={block.text ?? ''} /> : null}
                {block.kind === 'thinking' ? <ThinkingBlock text={block.text ?? ''} /> : null}
                {block.kind === 'tool-call' ? <ToolCallBlock block={block} /> : null}
                {block.kind === 'tool-result' ? <ToolResultBlock block={block} /> : null}
              </div>
            )
          })}
        </div>

        {blocks.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
            No messages yet — say hello.
          </div>
        ) : null}
      </div>

      {!atBottom && blocks.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            setAtBottom(true)
            virtualizer.scrollToBottom('smooth')
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-1 text-xs font-medium text-fg-on-accent shadow-2 transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          jump to latest ↓
        </button>
      ) : null}
    </div>
  )
}
