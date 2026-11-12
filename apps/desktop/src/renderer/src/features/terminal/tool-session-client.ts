import { useMemo } from 'react'
import {
  createSessionClient,
  parseSessionViewKey,
  useSessionClient,
  type SessionClient,
} from '../session/session-client'

function refuse(client: SessionClient, reason: string): SessionClient {
  const reject = async (): Promise<never> => { throw new Error(reason) }
  return {
    ...client,
    availability: 'unavailable', readOnly: true,
    invoke: reject, subscribe: () => () => undefined,
    capabilityReason: () => reason,
    receipt: () => null, checkReceipt: reject, stageImages: reject,
  }
}

/** Tools retain their pane's owner even when the shell changes its selected chat. */
export function useToolSessionClient(sessionId?: string): SessionClient {
  const inherited = useSessionClient()
  return useMemo(() => {
    if (inherited.scope.kind === 'remote') {
      if (sessionId && sessionId !== inherited.scope.sessionId && sessionId !== inherited.viewKey)
        return refuse(inherited, 'This tool belongs to another machine or session.')
      return inherited
    }
    if (!sessionId?.startsWith('[')) return inherited
    const scope = parseSessionViewKey(sessionId)
    if (scope?.kind !== 'remote') return refuse(inherited, 'The remote tool reference is invalid.')
    return createSessionClient(scope)
  }, [inherited, sessionId])
}

/** UI tuple IDs never cross the wire as session IDs or become local project roots. */
export function toolWireScope<T extends { sessionId?: string; projectId?: string }>(
  client: SessionClient,
  scope: T,
): T | { sessionId: string } {
  if (client.scope.kind === 'remote' && scope.sessionId &&
    (scope.sessionId === client.scope.sessionId || scope.sessionId === client.viewKey))
    return { sessionId: client.scope.sessionId }
  return scope
}
