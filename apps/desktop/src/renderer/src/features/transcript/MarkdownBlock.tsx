import { useEffect, useState } from 'react'
import { renderMarkdown } from './markdown'

/** Renders one markdown block. Async highlight-free pipeline, memoized by text. */
export function MarkdownBlock({ text }: { text: string }) {
  const [html, setHtml] = useState(() => renderMarkdown(text))

  useEffect(() => {
    let cancelled = false
    // renderMarkdown is sync today; the indirection keeps the door open for
    // async Shiki highlighting without changing call sites.
    const next = Promise.resolve(renderMarkdown(text))
    void next.then((h) => {
      if (!cancelled) setHtml(h)
    })
    return () => {
      cancelled = true
    }
  }, [text])

  return <div className="ari-md" dangerouslySetInnerHTML={{ __html: html }} />
}
