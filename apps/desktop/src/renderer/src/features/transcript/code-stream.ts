import { hastToHtml, type GrammarState } from 'shiki'
import { HIGHLIGHT_THEME_OPTIONS, warmHighlighter } from './highlight'

/**
 * How to bring a `<code>` element up to date: keep its first `keep` lines —
 * each a line element and the newline after it — and put `html` where the
 * rest was.
 */
export interface CodePatch {
  keep: number
  html: string
}

/** Highlights one code block as it is written, a line at a time. */
export interface CodeStream {
  /**
   * The patch that takes the element from the last source this stream saw to
   * `source`. Null until the highlighter is warm for the language.
   */
  advance(source: string): CodePatch | null
}

/**
 * Creates the highlighter for one streaming code block.
 *
 * A grammar tokenizes line by line, carrying its state from each line to the
 * next. So a finished line never has to be tokenized again: the stream keeps
 * the state after the last finished line and, on each flush, highlights only
 * the lines completed since and the one still being typed. Highlighting the
 * whole block per flush cost more with every line and stalled the stream on a
 * long file.
 */
export function createCodeStream(lang: string): CodeStream {
  /** Source of the finished lines, each with its newline. */
  let done = ''
  let doneLines = 0
  let state: GrammarState | undefined

  return {
    advance(source) {
      const highlighter = warmHighlighter(lang)
      if (highlighter === null) return null
      const lines = (code: string): { html: string; state: GrammarState | undefined } => {
        const root = highlighter.codeToHast(code, {
          lang,
          ...HIGHLIGHT_THEME_OPTIONS,
          ...(state ? { grammarState: state } : {}),
        })
        const pre = root.children[0]
        const codeNode = pre?.type === 'element' ? pre.children[0] : undefined
        if (codeNode?.type !== 'element') throw new Error('unexpected highlighter output')
        return { html: hastToHtml(codeNode.children), state: highlighter.getLastGrammarState(root) }
      }

      try {
        if (!source.startsWith(done)) {
          done = ''
          doneLines = 0
          state = undefined
        }
        const keep = doneLines
        // The renderer ends code with a newline while the last line is still
        // being typed, so the line before a trailing newline stays open.
        const closed = source.endsWith('\n')
        const rest = source.slice(done.length, closed ? -1 : undefined)
        const cut = rest.lastIndexOf('\n')
        let html = ''
        if (cut >= 0) {
          const finished = rest.slice(0, cut)
          const result = lines(finished)
          html = `${result.html}\n`
          state = result.state
          done += `${finished}\n`
          doneLines += finished.split('\n').length
        }
        html += lines(rest.slice(cut + 1)).html
        return { keep, html: closed ? `${html}\n` : html }
      } catch {
        return null
      }
    },
  }
}
