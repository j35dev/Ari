import { useEffect, useState, type Ref } from 'react'
import { highlightCode, shikiInner } from './highlight'

/**
 * Renders `code` as plain mono immediately, then swaps in Shiki-highlighted
 * spans once the async highlighter answers. Unknown languages and highlight
 * failures keep the plain rendering. Shared by tool-argument and tool-result
 * bodies so commands and JSON get one consistent treatment.
 */
export function CodeBlock({
  code,
  lang,
  className,
  ref,
}: {
  code: string
  lang: string
  className?: string
  ref?: Ref<HTMLPreElement>
}) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void highlightCode(code, lang).then((result) => {
      if (!cancelled) setHtml(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, lang])

  if (html === null) {
    return <pre ref={ref} className={className}>{code}</pre>
  }
  return (
    <pre ref={ref} className={className}>
      <code dangerouslySetInnerHTML={{ __html: shikiInner(html) }} />
    </pre>
  )
}
