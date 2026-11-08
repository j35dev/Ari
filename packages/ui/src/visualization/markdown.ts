import { unified } from 'unified'
import remarkParse from 'remark-parse'

const parser = unified().use(remarkParse)
export type VisualReplyPart =
  { kind: 'markdown'; text: string } | { kind: 'visualization'; source: string; complete: boolean }

/** Only actual top-level fences opt in. Examples in quotes, lists and code stay code. */
export function splitVisualizations(text: string): VisualReplyPart[] {
  // Keep the ordinary, high-frequency transcript path allocation-free.
  if (!/(?:^|\n) {0,3}(?:`{3,}|~{3,})ari-viz(?:\s|$)/.test(text))
    return [{ kind: 'markdown', text }]
  const tree = parser.parse(text)
  const parts: VisualReplyPart[] = []
  let offset = 0
  for (const node of tree.children) {
    if (node.type !== 'code' || node.lang !== 'ari-viz') continue
    const rawStart = node.position?.start.offset
    const end = node.position?.end.offset
    if (rawStart === undefined || end === undefined) continue
    const start = rawStart - ((node.position?.start.column ?? 1) - 1)
    const raw = text.slice(start, end)
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1]
    if (opener === undefined) continue
    const last = raw.trimEnd().split('\n').at(-1)?.replace(/\r$/, '') ?? ''
    const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(last)?.[1]
    const complete =
      closer !== undefined &&
      closer[0] === opener[0] &&
      closer.length >= opener.length &&
      raw.includes('\n')
    if (start > offset) parts.push({ kind: 'markdown', text: text.slice(offset, start) })
    parts.push({ kind: 'visualization', source: node.value, complete })
    offset = end
  }
  if (parts.length === 0) return [{ kind: 'markdown', text }]
  if (offset < text.length) parts.push({ kind: 'markdown', text: text.slice(offset) })
  // Definitions resolve throughout a Markdown document, including across a visual.
  const definitions = tree.children
    .filter((node) => node.type === 'definition')
    .map((node) => text.slice(node.position?.start.offset, node.position?.end.offset))
    .join('\n')
  if (definitions)
    for (const part of parts) if (part.kind === 'markdown') part.text += `\n\n${definitions}`
  return parts
}
