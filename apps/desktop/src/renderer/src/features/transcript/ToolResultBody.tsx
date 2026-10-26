import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { DiffViewer } from '../diffs'
import { CodeBlock } from './CodeBlock'
import { CopyButton } from './CopyButton'

/**
 * Heuristic for diff-shaped tool results: a real unified diff has at least one
 * `diff --git` header followed by a hunk marker. Checking both keeps plain
 * text that merely mentions "---" from being mis-rendered as a diff.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (text.length > 512 * 1024) return false
  return /(^|\n)diff --git /.test(text) && /(^|\n)@@ -\d+/.test(text)
}

/**
 * Content beyond roughly a dozen lines (or a dense 1200-char run) gets a
 * show-more toggle; a char floor catches single-line payloads like minified
 * output that would still fill the collapsed box. Pure so tests skip layout.
 */
export function isClippable(text: string): boolean {
  if (text.length > 1200) return true
  return text.split('\n').length > 12
}

const BODY_CLASS = 'overflow-auto border-t border-border bg-surface-0 p-2 font-mono text-2xs text-fg-muted'

type McpContentItem = { kind: 'text'; text: string } | { kind: 'placeholder'; label: string }

const MCP_CONTENT_TYPES = new Set(['text', 'image', 'audio', 'resource', 'resource_link'])

function isTextBlock(block: Record<string, unknown>): block is { type: 'text'; text: string } {
  return block.type === 'text' && typeof block.text === 'string'
}

/**
 * Image blocks (MCP `data`/`mimeType` or Anthropic `source`) are never decoded
 * here: the provider pipeline promotes them to the transcript image row, so
 * the card only points at it and no base64 reaches the DOM.
 */
function toContentItem(block: Record<string, unknown>): McpContentItem {
  if (isTextBlock(block)) return { kind: 'text', text: block.text }
  if (block.type === 'image') return { kind: 'placeholder', label: 'Image shown below' }
  return { kind: 'placeholder', label: 'Unsupported content' }
}

/**
 * MCP content result (`{ content: [...] }` or a bare block array) whose blocks
 * all have a known MCP type and at least one isn't valid text, as renderable
 * items; null for anything else, which keeps it on the plain JSON path.
 */
function mcpContentItems(parsed: unknown): McpContentItem[] | null {
  const blocks: unknown =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { content?: unknown }).content
      : parsed
  if (!Array.isArray(blocks)) return null
  const records = blocks.filter(
    (block): block is Record<string, unknown> =>
      block !== null &&
      typeof block === 'object' &&
      typeof (block as { type?: unknown }).type === 'string' &&
      MCP_CONTENT_TYPES.has((block as { type: string }).type),
  )
  if (records.length !== blocks.length || records.every(isTextBlock)) {
    return null
  }
  return records.map(toContentItem)
}

/**
 * Result card body: shared DiffViewer when the payload is a unified diff,
 * text and placeholders for MCP content (images show in the image row), otherwise
 * Shiki-highlighted JSON or plain terminal text — copyable, and expandable
 * past the collapsed clip when the output is long.
 */
export function ToolResultBody({ resultJson }: { resultJson: string }) {
  const isDiff = useMemo(() => looksLikeUnifiedDiff(resultJson), [resultJson])
  const parsed = useMemo(() => {
    try {
      const value: unknown = JSON.parse(resultJson)
      return {
        text: JSON.stringify(value, null, 2) ?? resultJson,
        isJson: true,
        content: mcpContentItems(value),
      }
    } catch {
      return { text: resultJson, isJson: false, content: null }
    }
  }, [resultJson])

  if (isDiff) return <DiffViewer diffText={resultJson} />
  if (parsed.content) return <McpContentBody items={parsed.content} />
  return <TextBody text={parsed.text} lang={parsed.isJson ? 'json' : 'text'} />
}

function McpContentBody({ items }: { items: McpContentItem[] }) {
  return (
    <div className="bg-surface-0">
      {items.map((item, i) =>
        item.kind === 'text' ? (
          <TextBody key={i} text={item.text} lang="text" />
        ) : (
          <div key={i} className="border-t border-border p-2 text-2xs text-fg-subtle">
            {item.label}
          </div>
        ),
      )}
    </div>
  )
}

function TextBody({ text, lang }: { text: string; lang: string }) {
  const [expanded, setExpanded] = useState(false)
  const clippable = isClippable(text)
  return (
    <div className="relative">
      <div className="absolute right-1 top-1.5 z-pane-chrome">
        <CopyButton text={text} />
      </div>
      <CodeBlock
        code={text}
        lang={lang}
        className={`${BODY_CLASS} ${expanded ? 'max-h-[480px]' : 'max-h-40'} whitespace-pre-wrap break-all pr-8`}
      />
      {clippable ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="flex w-full items-center justify-center gap-1 border-t border-border py-1 text-2xs text-fg-subtle transition-colors hover:bg-surface-1 hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
        >
          {expanded ? (
            <>
              <ChevronUp size={10} /> Show less
            </>
          ) : (
            <>
              <ChevronDown size={10} /> Show more
            </>
          )}
        </button>
      ) : null}
    </div>
  )
}
