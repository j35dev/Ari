import { useMemo } from 'react'
import { DiffViewer } from '../diffs'

/**
 * Heuristic for diff-shaped tool results: a real unified diff has at least one
 * `diff --git` header followed by a hunk marker. Checking both keeps plain
 * text that merely mentions "---" from being mis-rendered as a diff.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (text.length > 512 * 1024) return false
  return /(^|\n)diff --git /.test(text) && /(^|\n)@@ -\d+/.test(text)
}

/** Result card body: shared DiffViewer when the payload is a unified diff. */
export function ToolResultBody({ resultJson }: { resultJson: string }) {
  const isDiff = useMemo(() => looksLikeUnifiedDiff(resultJson), [resultJson])
  if (isDiff) return <DiffViewer diffText={resultJson} />
  let pretty: string = resultJson
  try {
    pretty = JSON.stringify(JSON.parse(resultJson), null, 2)
  } catch {
    // keep raw string
  }
  return <pre className="max-h-40 overflow-auto border-t border-border bg-surface-0 p-2 font-mono text-2xs text-fg-muted">{pretty}</pre>
}
