import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

const COPIED_RESET_MS = 1200

/**
 * Tiny icon button that copies `text` to the clipboard and flashes a check
 * mark for 1.2s to confirm. Used by code blocks and message footers.
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current)
    }
  }, [])

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS)
    })
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label="Copy"
      data-copied={copied ? 'true' : undefined}
      className="inline-flex items-center rounded-sm p-1 text-fg-subtle transition-colors hover:bg-surface-1 hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}
