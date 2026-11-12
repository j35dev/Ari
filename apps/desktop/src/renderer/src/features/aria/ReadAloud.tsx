import { useState } from 'react'
import { Volume2, Square } from 'lucide-react'
import { useEngineSettings } from '../settings/useEngineSettings'
import { rpc } from '../../lib/rpc'
import { iconButton } from '../../lib/recipes'

export function ReadAloud({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  const { settings } = useEngineSettings()
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState('')
  if (!settings?.experimental.ariaEnabled) return null
  return (
    <>
      <button
        type="button"
        aria-label={speaking ? 'Stop reading' : 'Read aloud'}
        title={speaking ? 'Stop reading' : 'Read aloud'}
        aria-pressed={speaking}
        className={iconButton}
        onClick={() => {
          setError('')
          if (speaking) {
            setSpeaking(false)
            void rpc.invoke('aria.voice.stop')
            return
          }
          setSpeaking(true)
          void rpc
            .invoke('aria.voice.read', { sessionId, messageId })
            .catch((reason) => setError(String(reason)))
            .finally(() => setSpeaking(false))
        }}
      >
        {speaking ? (
          <Square size={13} strokeWidth={1.7} aria-hidden />
        ) : (
          <Volume2 size={14} strokeWidth={1.7} aria-hidden />
        )}
      </button>
      {error && (
        <span role="alert" className="max-w-56 truncate px-1 text-xs text-danger" title={error}>
          {error}
        </span>
      )}
    </>
  )
}
