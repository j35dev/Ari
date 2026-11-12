import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@ari/contracts/session'
import { createLogger } from '@ari/shared/logger'
import { useSessionClient } from './session-client'

const log = createLogger('session:title')

export interface SessionTitle {
  /** Current title; null until the initial `session.load` resolves. */
  title: string | null
  /** Persists a new title via the `session.update` command and adopts it locally. */
  rename: (title: string) => Promise<void>
}

/**
 * Loads a session's title via `session.load` on mount (reloading when
 * `sessionId` changes); `rename` dispatches the `session.update` command
 * through the engine and reflects the new title immediately.
 */
export function useSessionTitle(sessionId: string): SessionTitle {
  const rpc = useSessionClient()
  const [title, setTitle] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setTitle(null)
    void rpc
      .invoke('session.load', { sessionId })
      .then((model) => {
        if (cancelled || !model) return
        const session = (model as { session?: Session }).session
        if (session) setTitle(session.title)
      })
      .catch((error: unknown) => {
        log.warn('session.load failed; title unavailable', { error })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, rpc, rpc.authorizationEpoch])

  const rename = useCallback(
    async (next: string): Promise<void> => {
      const result = await rpc.invoke('command.dispatch', {
        command: { type: 'session.update', sessionId, title: next },
      })
      if (!result.accepted) throw new Error(result.reason ?? 'The host refused the title change.')
      setTitle(next)
    },
    [sessionId, rpc],
  )

  return { title, rename }
}
