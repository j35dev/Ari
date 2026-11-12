import { X } from 'lucide-react'
import { iconButton } from '../../lib/recipes'

/**
 * Voice could not speak or listen. One row in the settings group it belongs
 * to: the attention glyph, what happened, and a way to dismiss it.
 */
export function VoiceNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 px-4 py-3">
      <span aria-hidden="true" className="ari-status mt-[3px]" data-status="attention" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-fg">Voice needs attention</p>
        <p className="mt-0.5 break-words text-[13px] leading-5 text-fg-subtle">{message}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss voice notice"
        className={iconButton}
      >
        <X size={14} strokeWidth={1.7} aria-hidden="true" />
      </button>
    </div>
  )
}
