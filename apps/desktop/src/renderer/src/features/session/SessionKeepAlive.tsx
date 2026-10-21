import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react'
import { keepAliveActions, useKeptSessions } from './session-keep-alive'

/**
 * One pane's session views. The session on screen renders as usual; the ones
 * the pane showed recently stay mounted behind it, hidden, so switching back
 * is a same-frame swap with history, drafts and scroll intact instead of a
 * remount and a journal replay.
 *
 * `render` receives whether that session is the hidden kind. A hidden view's
 * element is reused as-is until it is shown again, so shell re-renders never
 * reach the views nobody can see.
 */
export function SessionKeepAlive({
  poolId,
  sessionId,
  hidden = false,
  render,
}: {
  poolId: string
  sessionId: string
  /** The whole pane is off screen (a space in the background): its current session hides too. */
  hidden?: boolean
  render: (sessionId: string, hidden: boolean) => ReactNode
}) {
  const kept = useKeptSessions(poolId)
  useLayoutEffect(() => keepAliveActions.retain(poolId, sessionId), [poolId, sessionId])
  // A layout cleanup, so a pane remounting under the same id (one pane
  // becoming two) releases before its successor retains, never after.
  useLayoutEffect(() => () => keepAliveActions.releasePool(poolId), [poolId])

  const hiddenElements = useRef(new Map<string, ReactNode>())
  // A stable order: React moves keyed children when their order changes, and
  // a moved node loses its scroll position.
  const ids = [...new Set([sessionId, ...kept])].sort()
  const nextHidden = new Map<string, ReactNode>()
  const views = ids.map((id) => {
    if (id === sessionId) return <Fragment key={id}>{render(id, hidden)}</Fragment>
    const element = hiddenElements.current.get(id) ?? (
      <Fragment key={id}>{render(id, true)}</Fragment>
    )
    nextHidden.set(id, element)
    return element
  })
  hiddenElements.current = nextHidden
  return <>{views}</>
}
