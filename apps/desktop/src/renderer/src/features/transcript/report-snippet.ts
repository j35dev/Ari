/** Long enough to fill a wide row; the row truncates what does not fit. */
const SNIPPET_MAX = 240

/**
 * One plain line from an agent's markdown report, for a row that shows what
 * the agent said without rendering it. Formatting marks go, the words stay:
 * `**Report** - *Orbital Garden*` reads `Report - Orbital Garden`.
 */
export function reportSnippet(markdown: string): string {
  return (
    markdown
      // Fenced code is not a summary; drop the block, keep the prose around it.
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      // Images and links keep their label.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Heading, quote, list and numbering marks at the start of a line.
      .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/\*(?=\S)([^*\n]*?\S)\*/g, '$1')
      // Underscore emphasis only at word edges: snake_case names stay whole.
      .replace(/(?<![\w])_(?=\S)([^_\n]*?\S)_(?![\w])/g, '$1')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SNIPPET_MAX)
  )
}
