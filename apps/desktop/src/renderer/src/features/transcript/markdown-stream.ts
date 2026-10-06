import { markdownProcessor, renderMarkdown } from './markdown'

type MarkdownTree = ReturnType<typeof markdownProcessor.parse>
type MarkdownNode = MarkdownTree['children'][number]

/**
 * Renders a growing markdown source as one HTML string per top-level block,
 * re-parsing only the block the text is still being appended to.
 */
export interface MarkdownStream {
  /** HTML for each top-level block of `markdown`, in document order. */
  render(markdown: string): string[]
}

/**
 * A definition resolves references anywhere in the document, including in
 * blocks that came before it, so a source holding one cannot be parsed in
 * pieces.
 */
function hasDefinition(node: { type: string; children?: unknown[] }): boolean {
  if (node.type === 'definition' || node.type === 'footnoteDefinition') return true
  return (node.children ?? []).some((child) =>
    hasDefinition(child as { type: string; children?: unknown[] }),
  )
}

function htmlBlocks(children: MarkdownNode[]): string[] {
  const tree = markdownProcessor.runSync({ type: 'root', children })
  const blocks: string[] = []
  for (const child of tree.children) {
    if (child.type === 'text' && child.value.trim().length === 0) continue
    blocks.push(markdownProcessor.stringify({ type: 'root', children: [child] }))
  }
  return blocks
}

/** Source offset of the line `node` starts on, so its indentation travels with it. */
function lineStart(node: MarkdownNode): number | null {
  const start = node.position?.start
  if (start?.offset === undefined) return null
  return start.offset - (start.column - 1)
}

/**
 * Creates a renderer for one streaming text block.
 *
 * A block-level construct is final once another one follows it: appended text
 * can only extend or reshape the *last* top-level block. So each render parses
 * from the start of that last block, and everything before it is rendered once
 * and kept. A streamed reply costs its newest paragraph per flush rather than
 * the whole message, and the settled result is the same HTML a single pass
 * over the full source produces.
 */
export function createMarkdownStream(): MarkdownStream {
  let source = ''
  /** Blocks rendered from `source.slice(0, settledOffset)`; never revisited. */
  let settled: string[] = []
  let settledOffset = 0
  let whole = false

  const renderWhole = (markdown: string): string[] => {
    whole = true
    source = markdown
    settled = []
    settledOffset = 0
    return htmlBlocks(markdownProcessor.parse(markdown).children)
  }

  return {
    render(markdown) {
      try {
        if (whole) return renderWhole(markdown)
        if (!markdown.startsWith(source)) {
          settled = []
          settledOffset = 0
        }
        source = markdown
        const tail = markdownProcessor.parse(markdown.slice(settledOffset))
        if (hasDefinition(tail)) return renderWhole(markdown)

        const last = tail.children[tail.children.length - 1]
        const cut = last === undefined ? null : lineStart(last)
        if (last === undefined || cut === null || cut <= 0 || tail.children.length === 1) {
          return [...settled, ...htmlBlocks(tail.children)]
        }
        settled = [...settled, ...htmlBlocks(tail.children.slice(0, -1))]
        settledOffset += cut
        return [...settled, ...htmlBlocks([last])]
      } catch {
        whole = true
        return [renderMarkdown(markdown)]
      }
    },
  }
}
