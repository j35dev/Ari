import { AlertTriangle } from 'lucide-react'

/**
 * One in-transcript failure note: the engine appends provider errors to the
 * assistant message as `⚠ <message>` text, and those blocks render here —
 * visually matching the turn-failed banner — instead of as plain markdown.
 */
export function ErrorNote({ text }: { text: string }) {
  return (
    <div
      role="note"
      aria-label="Error"
      className="my-1 flex items-start gap-2 rounded-md border border-danger-subtle bg-danger-subtle px-3 py-2"
    >
      <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
      <p className="min-w-0 flex-1 break-words whitespace-pre-wrap text-xs leading-relaxed text-fg-muted">
        {text}
      </p>
    </div>
  )
}
