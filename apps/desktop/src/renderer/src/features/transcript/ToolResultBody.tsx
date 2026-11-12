import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Dialog } from '@ari/ui/dialog'
import { iconButton } from '../../lib/recipes'
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

/** A section of the step's well: a hairline above it unless it comes first. */
const SECTION = 'border-t border-border first:border-t-0'

const BODY_CLASS = 'overflow-auto px-3 py-2 font-mono'

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
export function ToolResultBody({
  resultJson,
  expanded = false,
}: {
  resultJson: string
  expanded?: boolean
}) {
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

  if (isDiff)
    return (
      <div className={SECTION}>
        <DiffViewer diffText={resultJson} />
      </div>
    )
  if (parsed.content) return <McpContentBody items={parsed.content} expanded={expanded} />
  return (
    <TextBody
      text={parsed.text}
      lang={parsed.isJson ? 'json' : 'text'}
      defaultExpanded={expanded}
    />
  )
}

function McpContentBody({ items, expanded }: { items: McpContentItem[]; expanded: boolean }) {
  return (
    <div className={SECTION}>
      {items.map((item, i) => {
        if (item.kind === 'text')
          return <TextBody key={i} text={item.text} lang="text" defaultExpanded={expanded} />
        if (item.kind === 'image')
          return <McpImage key={i} dataUrl={item.dataUrl} label={item.label} />
        return (
          <div key={i} className={`${SECTION} px-3 py-2 text-xs text-fg-subtle`}>
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
    <div className={`${SECTION} p-3`}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open image"
        className="block max-w-full overflow-hidden rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <img src={dataUrl} alt={label} className="max-h-60 max-w-full object-contain" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* The panel is the shared dialog surface; the image sits in a well below its header. */}
        <Dialog.Content size="lg">
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border pl-4 pr-2.5">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate">{label}</Dialog.Title>
              <Dialog.Description className="sr-only">Tool result image preview</Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close image preview" className={iconButton}>
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-0 p-4">
            <img src={dataUrl} alt={label} className="max-h-full max-w-full object-contain" />
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}

function TextBody({
  text,
  lang,
  defaultExpanded = false,
}: {
  text: string
  lang: string
  defaultExpanded?: boolean
}) {
  const [override, setOverride] = useState<boolean | null>(null)
  const expanded = override ?? defaultExpanded
  const clippable = isClippable(text)
  return (
    <div className={`group/result relative ${SECTION}`}>
      {/* Floats over the output and shows itself on hover or focus. */}
      <div className="absolute right-1 top-1 z-pane-chrome rounded-md bg-surface-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover/result:opacity-100">
        <CopyButton text={text} />
      </div>
      <CodeBlock
        code={text}
        lang={lang}
        className={`${BODY_CLASS} ${expanded ? 'max-h-[480px]' : 'max-h-40'} whitespace-pre-wrap break-all`}
      />
      {clippable ? (
        <button
          type="button"
          onClick={() => setOverride((previous) => !(previous ?? defaultExpanded))}
          aria-expanded={expanded}
          className="flex h-7 w-full items-center justify-center gap-1 border-t border-border text-xs text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
        >
          {expanded ? (
            <>
              <ChevronUp size={12} aria-hidden="true" /> Show less
            </>
          ) : (
            <>
              <ChevronDown size={12} aria-hidden="true" /> Show more
            </>
          )}
        </button>
      ) : null}
    </div>
  )
}
