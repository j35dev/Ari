import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { iconButton } from '../../lib/recipes'

const COPIED_RESET_MS = 1200

/**
 * Ghost icon button that copies `text` to the clipboard and flashes a check
 * mark for 1.2s to confirm. Used by tool details and message footers.
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
      className={iconButton}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}
