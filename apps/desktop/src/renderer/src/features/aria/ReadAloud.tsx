import { useState } from 'react'
import { Volume2, Square } from 'lucide-react'
import { useEngineSettings } from '../settings/useEngineSettings'
import { rpc } from '../../lib/rpc'

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
        className="inline-flex items-center rounded-sm p-1 text-fg-subtle hover:bg-surface-1 hover:text-fg-muted"
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
        {speaking ? <Square size={12} /> : <Volume2 size={12} />}
      </button>
      {error && <span role="alert">{error}</span>}
    </>
  )
}
