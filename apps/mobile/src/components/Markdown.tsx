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
        const copy = event.target.closest('[data-copy-code]')
        if (copy !== null) {
          const code = copy.closest('.code-block')?.querySelector('pre')?.textContent ?? ''
          void navigator.clipboard
            .writeText(code)
            .then(() => (copy.textContent = 'Copied'))
            .catch(() => (copy.textContent = 'Clipboard unavailable'))
          return
        }
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
