import { useEffect, useRef, useState } from 'react'
import { highlightCode } from './highlight'
import { renderMarkdown } from './markdown'

/** Extracts the highlighted spans from Shiki's `<pre>` wrapper for injection into an existing code element. */
function shikiInner(html: string): string {
  return /<code[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1] ?? html
}

/**
 * Renders one markdown block, then swaps fenced `language-*` code elements to
 * Shiki-highlighted content. Falls back to the plain markdown rendering when a
 * language is unknown or highlighting fails.
 */
export function MarkdownBlock({ text }: { text: string }) {
  const [html, setHtml] = useState(() => renderMarkdown(text))
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    // renderMarkdown is sync today; the indirection keeps the door open for
    // async pipelines without changing call sites.
    const next = Promise.resolve(renderMarkdown(text))
    void next.then((h) => {
      if (!cancelled) setHtml(h)
    })
    return () => {
      cancelled = true
    }
  }, [text])

  useEffect(() => {
    let cancelled = false
    const root = ref.current
    if (!root) return
    for (const el of root.querySelectorAll<HTMLElement>('pre code[class*="language-"]')) {
      const lang = /(?:^|\s)language-([\w#+.-]+)/.exec(el.className)?.[1]
      if (!lang) continue
      void highlightCode(el.textContent ?? '', lang).then((result) => {
        if (cancelled || result === null || !el.isConnected) return
        el.innerHTML = shikiInner(result)
      })
    }
    return () => {
      cancelled = true
    }
  }, [html])

  return <div ref={ref} className="ari-md" dangerouslySetInnerHTML={{ __html: html }} />
}
