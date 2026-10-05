import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkRehype from 'remark-rehype'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'

interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

const element = (tagName: string, properties: Record<string, unknown>, children: Node[]): Node => ({
  type: 'element',
  tagName,
  properties,
  children,
})

/**
 * Wraps each code block with its language and a copy button. Runs after
 * sanitizing, so these are the only buttons a transcript can contain.
 */
function codeBlocks() {
  const visit = (node: Node): void => {
    node.children = node.children?.map((child) => {
      if (child.type !== 'element' || child.tagName !== 'pre') {
        visit(child)
        return child
      }
      const classes = child.children?.[0]?.properties?.['className']
      const language = (Array.isArray(classes) ? classes : [])
        .map(String)
        .find((name) => name.startsWith('language-'))
        ?.slice('language-'.length)
      return element('div', { className: ['code-block'] }, [
        element('div', { className: ['code-block-head'] }, [
          element('span', {}, [{ type: 'text', value: language ?? 'Code' }]),
          element('button', { type: 'button', dataCopyCode: true }, [
            { type: 'text', value: 'Copy' },
          ]),
        ]),
        child,
      ])
    })
  }
  return visit
}

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
  .use(codeBlocks)
  .use(rehypeStringify)

/** Render agent Markdown without raw HTML, scripts, or remote resource loads. */
export function renderMarkdown(text: string): string {
  return String(renderer.processSync(text))
}
