import { useMemo, type ReactNode } from 'react'
import { renderMarkdown } from '../lib/markdown'

/** Sanitized Markdown; external links leave the workbench in a separate tab. */
export function Markdown({ text }: { text: string }): ReactNode {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div
      className="markdown"
      onClick={(event) => {
        if (!(event.target instanceof Element)) return
        const anchor = event.target.closest('a')
        if (anchor !== null) {
          anchor.target = '_blank'
          anchor.rel = 'noopener noreferrer'
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
