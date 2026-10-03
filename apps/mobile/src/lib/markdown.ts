import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkRehype from 'remark-rehype'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'

const renderer = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkRehype)
  .use(rehypeSanitize, {
    ...defaultSchema,
    // Transcript text cannot load remote tracking pixels or arbitrary image resources.
    tagNames: defaultSchema.tagNames?.filter((name) => name !== 'img'),
  })
  .use(rehypeStringify)

/** Render agent Markdown without raw HTML, scripts, or remote resource loads. */
export function renderMarkdown(text: string): string {
  return String(renderer.processSync(text))
}
