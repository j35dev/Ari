import { AriaMark } from '@ari/ui/aria-mark'
import type { WidgetSnapshot } from '../../main/aria-widget/model'

export function Widget(props: {
  state: WidgetSnapshot
  level: number
  onSetup: () => void
}): React.JSX.Element | null {
  const { state, level, onSetup } = props
  if (state.phase === 'hidden' || state.phase === 'arming') return null
  const text =
    state.phase === 'listening'
      ? 'Listening'
      : state.phase === 'transcribing'
        ? 'Transcribing'
        : state.text
  const pose =
    state.phase === 'error' ? 'attention' : state.phase === 'transcribing' ? 'thinking' : 'idle'
  return (
    <button
      className="aria-pill"
      data-phase={state.phase}
      onClick={state.setup ? onSetup : undefined}
      tabIndex={-1}
      aria-label={state.setup ? `${text}. Open speech settings` : text}
    >
      <AriaMark size={24} state={pose} />
      <span className="aria-pill-text" role="status">
        {text}
      </span>
      {state.phase === 'listening' && (
        <span className="aria-level" aria-label="Microphone level">
          {[0.45, 0.7, 1, 0.8, 0.55, 0.9, 0.6].map((scale, index) => (
            <i
              key={index}
              style={{ transform: `scaleY(${0.15 + Math.min(1, level * 6) * scale * 0.85})` }}
            />
          ))}
        </span>
      )}
      {state.phase === 'transcribing' && (
        <span className="aria-progress" aria-hidden="true">
          ···
        </span>
      )}
      {state.phase === 'sent' && (
        <span className="aria-sent" aria-label="Sent">
          ✓
        </span>
      )}
    </button>
  )
}
