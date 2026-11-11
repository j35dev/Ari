import { Check, Mic, X } from 'lucide-react'
import type { WidgetSnapshot } from '../../main/aria-widget/model'

/** The shared capture lifecycle presented as insertion into a field. */
export function DictationIndicator({
  state,
  level,
  onSetup,
}: {
  state: WidgetSnapshot
  level: number
  onSetup: () => void
}) {
  if (state.phase === 'hidden') return null
  const phase =
    state.phase === 'listening' ? 'recording' : state.phase === 'sent' ? 'inserted' : state.phase
  const text =
    phase === 'recording'
      ? 'Dictating into this field'
      : phase === 'transcribing'
        ? 'Transcribing'
        : phase === 'inserted'
          ? 'Inserted'
          : state.text
  const Icon = phase === 'inserted' ? Check : phase === 'error' ? X : Mic
  return (
    <button
      className="dictation-indicator"
      data-phase={phase}
      onClick={state.setup ? onSetup : undefined}
      tabIndex={-1}
      aria-label={state.setup ? `${text}. Open speech settings` : text}
    >
      <Icon size={18} strokeWidth={1.8} aria-hidden />
      <span className="dictation-text" role="status">
        {text}
      </span>
      {phase === 'recording' && (
        <span className="dictation-level" aria-label="Microphone level">
          {[0.45, 0.7, 1, 0.8, 0.55].map((scale, index) => (
            <i
              key={index}
              style={{ transform: `scaleY(${0.15 + Math.min(1, level * 6) * scale * 0.85})` }}
            />
          ))}
        </span>
      )}
      {phase === 'transcribing' && (
        <span className="dictation-progress" aria-hidden>
          ···
        </span>
      )}
    </button>
  )
}
