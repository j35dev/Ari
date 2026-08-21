import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkRehype from 'remark-rehype'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'

/**
 * Markdown → safe HTML for transcript blocks. CommonMark + GFM (tables,
 * strikethrough, autolinks) + hard line breaks. Raw HTML is sanitized away;
 * link hrefs are scheme-restricted so the output is safe for
 * `dangerouslySetInnerHTML`.
 */

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkRehype)
  .use(rehypeSanitize, {
    ...defaultSchema,
    protocols: { href: ['http', 'https', 'mailto'] },
    tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== 'script' && t !== 'style'),
  })
  .use(rehypeStringify)

/** Renders markdown to safe HTML. Total: falls back to escaped text. */
export function renderMarkdown(markdown: string): string {
  try {
    return String(processor.processSync(markdown))
  } catch {
    const div = markdown.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c)
    return `<p>${div}</p>`
  }
}
