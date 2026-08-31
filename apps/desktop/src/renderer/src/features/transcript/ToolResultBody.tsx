import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { DiffViewer } from '../diffs'
import { CodeBlock } from './CodeBlock'
import { CopyButton } from './CopyButton'

/**
 * Heuristic for diff-shaped tool results: a real unified diff has at least one
 * `diff --git` header followed by a hunk marker. Checking both keeps plain
 * text that merely mentions "---" from being mis-rendered as a diff.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  if (text.length > 512 * 1024) return false
  return /(^|\n)diff --git /.test(text) && /(^|\n)@@ -\d+/.test(text)
}

/**
 * Content beyond roughly a dozen lines (or a dense 1200-char run) gets a
 * show-more toggle; a char floor catches single-line payloads like minified
 * output that would still fill the collapsed box. Pure so tests skip layout.
 */
export function isClippable(text: string): boolean {
  if (text.length > 1200) return true
  return text.split('\n').length > 12
}

const BODY_CLASS = 'overflow-auto border-t border-border bg-surface-0 p-2 font-mono text-2xs text-fg-muted'

/**
 * Result card body: shared DiffViewer when the payload is a unified diff,
 * otherwise Shiki-highlighted JSON or plain terminal text — copyable, and
 * expandable past the collapsed clip when the output is long.
 */
export function ToolResultBody({ resultJson }: { resultJson: string }) {
  const isDiff = useMemo(() => looksLikeUnifiedDiff(resultJson), [resultJson])
  const { text, isJson } = useMemo(() => {
    try {
      return { text: JSON.stringify(JSON.parse(resultJson), null, 2) ?? resultJson, isJson: true }
    } catch {
      return { text: resultJson, isJson: false }
    }
  }, [resultJson])
  const [expanded, setExpanded] = useState(false)

  if (isDiff) return <DiffViewer diffText={resultJson} />

  const clippable = isClippable(text)
  return (
    <div className="relative">
      <div className="absolute right-1 top-1.5 z-10">
        <CopyButton text={text} />
      </div>
      <CodeBlock
        code={text}
        lang={isJson ? 'json' : 'text'}
        className={`${BODY_CLASS} ${expanded ? 'max-h-[480px]' : 'max-h-40'} whitespace-pre-wrap break-all pr-8`}
      />
      {clippable ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="flex w-full items-center justify-center gap-1 border-t border-border py-1 text-2xs text-fg-subtle transition-colors hover:bg-surface-1 hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
        >
          {expanded ? (
            <>
              <ChevronUp size={10} /> Show less
            </>
          ) : (
            <>
              <ChevronDown size={10} /> Show more
            </>
          )}
        </button>
      ) : null}
    </div>
  )
}
