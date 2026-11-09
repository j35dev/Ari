import { useMemo, type ReactNode } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { Visualization } from '@ari/ui/visualization'
import { splitVisualizations } from '@ari/ui/visualization-markdown'

/** Sanitized Markdown; external links leave the workbench in a separate tab. */
function MarkdownText({ text }: { text: string }): ReactNode {
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

export function Markdown({
  text,
  streaming = false,
}: {
  text: string
  streaming?: boolean
}): ReactNode {
  const parts = useMemo(() => splitVisualizations(text), [text])
  if (parts.length === 1 && parts[0]?.kind === 'markdown') return <MarkdownText text={text} />
  return (
    <div className="ari-visual-reply">
      {parts.map((part, i) =>
        part.kind === 'markdown' ? (
          <MarkdownText key={i} text={part.text} />
        ) : (
          <Visualization key={i} source={part.source} pending={streaming && !part.complete} />
        ),
      )}
    </div>
  )
}
