import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Dialog } from '@ari/ui/dialog'
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

const BODY_CLASS =
  'overflow-auto border-t border-border bg-surface-0 p-2 font-mono text-2xs text-fg-muted'

type McpContentItem =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl: string; label: string }
  | { kind: 'placeholder'; label: string }

const MCP_CONTENT_TYPES = new Set(['text', 'image', 'audio'])
/** Mirrors the MCP ceiling; a larger payload would freeze the transcript. */
const MAX_IMAGE_BASE64 = 5 * 1024 * 1024
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/

function isTextBlock(block: Record<string, unknown>): block is { type: 'text'; text: string } {
  return block.type === 'text' && typeof block.text === 'string'
}

function imageData(block: Record<string, unknown>): { data: string; mimeType: string } | null {
  const source =
    block['source'] !== null && typeof block['source'] === 'object'
      ? (block['source'] as Record<string, unknown>)
      : block
  const data = source['data']
  const mimeType = source['media_type'] ?? source['mimeType']
  if (typeof data !== 'string' || data.length === 0) return null
  if (typeof mimeType !== 'string' || !IMAGE_MIME.test(mimeType)) return null
  return { data, mimeType }
}

/**
 * Image blocks (MCP `data`/`mimeType` or Anthropic `source`) become a bounded
 * data URL for a thumbnail. Malformed blocks never reach the DOM as text.
 */
function toContentItem(block: Record<string, unknown>): McpContentItem {
  if (isTextBlock(block)) return { kind: 'text', text: block.text }
  if (block.type === 'image') {
    const image = imageData(block)
    if (image === null) return { kind: 'placeholder', label: 'Image' }
    if (image.data.length > MAX_IMAGE_BASE64)
      return { kind: 'placeholder', label: 'Image too large' }
    return {
      kind: 'image',
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
      label: 'Image',
    }
  }
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
 * text and placeholders for MCP content, otherwise Shiki-highlighted JSON or
 * plain terminal text — copyable, and expandable past the collapsed clip when
 * the output is long.
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
      {items.map((item, i) => {
        if (item.kind === 'text') return <TextBody key={i} text={item.text} lang="text" />
        if (item.kind === 'image')
          return <McpImage key={i} dataUrl={item.dataUrl} label={item.label} />
        return (
          <div key={i} className="border-t border-border p-2 text-2xs text-fg-subtle">
            {item.label}
          </div>
        )
      })}
    </div>
  )
}

/** A bounded thumbnail; the full image opens in a preview dialog. */
function McpImage({ dataUrl, label }: { dataUrl: string; label: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-border p-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open image"
        className="block max-w-full overflow-hidden rounded-md border border-border bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <img src={dataUrl} alt={label} className="max-h-60 max-w-full object-contain" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <Dialog.Content size="lg" className="overflow-hidden bg-surface-0">
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-sm">{label}</Dialog.Title>
              <Dialog.Description className="sr-only">Tool result image preview</Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close image preview"
              className="flex size-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              <X size={15} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-0 p-4">
            <img
              src={dataUrl}
              alt={label}
              className="max-h-full max-w-full object-contain shadow-2"
            />
          </div>
        </Dialog.Content>
      </Dialog>
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
