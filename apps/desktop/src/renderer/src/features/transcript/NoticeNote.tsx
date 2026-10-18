import { Info } from 'lucide-react'

/**
 * Something Ari tells the user mid-turn that did not fail it: the model that
 * actually answered, what an approval now covers. Shown in full, since it is a
 * sentence to read rather than provider output to fold away, and without the
 * failure styling an error note carries.
 */
export function NoticeNote({ text }: { text: string }) {
  return (
    <div role="note" className="my-1 flex items-start gap-2 px-1 py-[3px] pl-4">
      <Info size={11} className="mt-[3px] shrink-0 text-fg-subtle" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-xs leading-relaxed text-fg-muted">{text.trim()}</span>
    </div>
  )
}
