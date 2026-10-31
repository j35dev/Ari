import { highlightCode, shikiInner } from '../transcript/highlight'
import type { HighlightRequest, HighlightReply } from './diff-highlight-pool'

self.onmessage = (event: MessageEvent<HighlightRequest>): void => {
  const { id, lang, lines } = event.data
  void (async (): Promise<void> => {
    const html: Record<string, string> = {}
    for (const side of ['old', 'new'] as const) {
      const source = lines.filter((line) => line.side === side)
      if (!source.length) continue
      const highlighted = await highlightCode(source.map((line) => line.text).join('\n'), lang)
      if (!highlighted) {
        self.postMessage({
          id,
          html,
          error: 'Syntax highlighting is unavailable.',
        } satisfies HighlightReply)
        return
      }
      const rendered = shikiInner(highlighted).split('\n')
      for (const [index, line] of source.entries())
        if (rendered[index]) html[line.key] = rendered[index]!
    }
    self.postMessage({ id, html } satisfies HighlightReply)
  })().catch((error: unknown) => {
    self.postMessage({ id, html: {}, error: String(error) } satisfies HighlightReply)
  })
}
