import { VolumeX, X } from 'lucide-react'

export function VoiceNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-t-xl bg-warning-subtle/25 px-4 py-3"
    >
      <VolumeX size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-fg">Voice needs attention</p>
        <p className="mt-1 break-words text-xs leading-relaxed text-fg-muted">{message}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss voice notice"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
