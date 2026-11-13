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
 * `dangerouslySetInnerHTML`. External links carry `target="_blank"` so they
 * route through the main-process `setWindowOpenHandler` (OS browser) even if
 * the renderer's delegated click interceptor ever misses them. HTML files an
 * agent names become links too; see {@linkcode localHtmlHref}.
 */

/**
 * The marker a link to a local HTML file carries. It is an in-page fragment,
 * so it passes the sanitizer and cannot navigate the window; the click
 * interceptor reads the path back out and asks the main process to open it.
 */
export const LOCAL_HTML_PREFIX = '#ari-html='

/** A path or `file:` URL that names an HTML file, as an agent writes one. */
const HTML_FILE = /^[^\s<>"|*]+\.html?(?:[#?][^\s]*)?$/i

/**
 * The marker href for `target` when it names a local HTML file, else null.
 * `needsFolder` is for bare inline code: `index.html` on its own is usually
 * a mention, so only something that reads as a path becomes a link.
 */
export function localHtmlHref(target: string, needsFolder = false): string | null {
  const text = target.trim()
  if (!HTML_FILE.test(text) || /^(?:https?|mailto):/i.test(text)) return null
  const local = /^file:/i.test(text)
  if (!local && /^[a-z][a-z0-9+.-]{1,}:/i.test(text)) return null
  if (needsFolder && !local && !/[\\/]/.test(text)) return null
  return LOCAL_HTML_PREFIX + encodeURIComponent(text)
}

interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

function isExternalHref(href: unknown): href is string {
  return (
    typeof href === 'string' &&
    (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:'))
  )
}

/** Tags external anchors so a click becomes a popup, never a navigation. */
function rehypeExternalTarget(): (tree: HastNode) => void {
  const visit = (node: HastNode): void => {
    if (
      node.type === 'element' &&
      node.tagName === 'a' &&
      isExternalHref(node.properties?.['href'])
    ) {
      node.properties = {
        ...node.properties,
        target: '_blank',
        rel: 'noopener noreferrer',
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  return (tree: HastNode) => visit(tree)
}

function textOf(node: HastNode & { value?: string }): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

/**
 * Makes HTML files an agent names openable: a markdown link to one, and a
 * path written as inline code. Runs before the sanitizer, which would
 * otherwise strip a `file:` or `C:\…` target as an unknown scheme.
 */
function rehypeLocalHtmlLinks(): (tree: HastNode) => void {
  const visit = (node: HastNode, insidePre: boolean): void => {
    node.children = node.children?.map((child) => {
      if (child.type !== 'element') return child
      if (child.tagName === 'a') {
        const href = child.properties?.['href']
        const marker = typeof href === 'string' ? localHtmlHref(href) : null
        if (marker !== null)
          child.properties = { ...child.properties, href: marker, title: 'Open in your browser' }
        return child
      }
      if (child.tagName === 'code' && !insidePre && node.tagName !== 'a') {
        const marker = localHtmlHref(textOf(child), true)
        if (marker !== null)
          return {
            type: 'element',
            tagName: 'a',
            properties: { href: marker, title: 'Open in your browser' },
            children: [child],
          }
      }
      return child
    })
    for (const child of node.children ?? []) visit(child, insidePre || child.tagName === 'pre')
  }
  return (tree: HastNode) => visit(tree, false)
}

/**
 * Relative image paths belong to a provider's working directory, not the
 * renderer origin, so Chromium can only show a broken-image glyph. Generated
 * files arrive separately as staged image parts; discard the unusable echo.
 */
function rehypeDropLocalImages(): (tree: HastNode) => void {
  const visit = (node: HastNode): void => {
    node.children = node.children?.filter((child) => {
      if (child.type !== 'element' || child.tagName !== 'img') return true
      const src = child.properties?.['src']
      return typeof src === 'string' && (src.startsWith('http://') || src.startsWith('https://'))
    })
    for (const child of node.children ?? []) visit(child)
  }
  return (tree: HastNode) => visit(tree)
}

/** The one pipeline every transcript surface renders through. */
export const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkRehype)
  .use(rehypeDropLocalImages)
  .use(rehypeLocalHtmlLinks)
  .use(rehypeSanitize, {
    ...defaultSchema,
    protocols: { href: ['http', 'https', 'mailto'] },
    tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== 'script' && t !== 'style'),
  })
  // After sanitize: its schema would strip target/rel, so this runs last.
  .use(rehypeExternalTarget)
  .use(rehypeStringify)

/** Renders markdown to safe HTML. Total: falls back to escaped text. */
export function renderMarkdown(markdown: string): string {
  try {
    return String(markdownProcessor.processSync(markdown))
  } catch {
    const div = markdown.replace(
      /[<>&"]/g,
      (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c,
    )
    return `<p>${div}</p>`
  }
}
