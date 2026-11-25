/**
 * Balances the inline markers a half-written paragraph leaves open, so a reply
 * being streamed shows `**bold` as bold and a half-typed `` `code `` as code
 * instead of flashing literal asterisks and backticks until the closer
 * arrives. Only the last paragraph is touched, and never inside an open fence.
 * A marker with nothing after it yet is dropped rather than closed.
 */
const TABLE_LINE = /^\s*\|/
const TABLE_RULE = /^\s*\|?\s*:?-{3,}/

/**
 * A table being written shows whole rows only: a half-typed row reads as a
 * line of pipes, and a header without its rule row is not a table yet, so
 * both wait until they are complete.
 */
function holdBackTable(paragraph: string): string {
  const lines = paragraph.split('\n')
  const first = lines.findIndex((line) => TABLE_LINE.test(line))
  if (first < 0) return paragraph
  const tail = lines.slice(first)
  if (!tail.every((line) => line === '' || TABLE_LINE.test(line))) return paragraph
  // The last line is unfinished unless the text ended on a newline.
  let rows = tail.at(-1) === '' ? tail : tail.slice(0, -1)
  rows = rows.filter((line) => line !== '')
  const formed = rows.length >= 2 && TABLE_RULE.test(rows[1] ?? '')
  const kept = [...lines.slice(0, first), ...(formed ? rows : [])]
  return kept.join('\n').replace(/\n+$/, '')
}

export function closeOpenInline(text: string): string {
  if (text.length === 0) return text
  const fences = text.match(/^ {0,3}(?:```|~~~)/gm)?.length ?? 0
  if (fences % 2 === 1) return text

  const start = text.lastIndexOf('\n\n') + 1
  let paragraph = holdBackTable(text.slice(start))
  let head = text.slice(0, start)
  if (paragraph.length === 0) return head.replace(/\n+$/, '')

  // A bare opener at the very end: drop it until something follows.
  const bare = /(^|\s)(\*{1,2}|_{1,2}|`|~~)$/.exec(paragraph)
  if (bare) {
    paragraph = paragraph.slice(0, paragraph.length - (bare[2]?.length ?? 0))
    if (paragraph.length === 0) return head.replace(/\n+$/, '')
  }
  head += paragraph

  const ticks = paragraph.match(/`/g)?.length ?? 0
  if (ticks % 2 === 1) return `${head}\``

  const outsideCode = paragraph.replace(/`[^`]*`/g, '')
  let suffix = ''
  if ((outsideCode.match(/\*\*/g)?.length ?? 0) % 2 === 1) suffix += '**'
  if ((outsideCode.match(/~~/g)?.length ?? 0) % 2 === 1) suffix += '~~'
  return head + suffix
}
