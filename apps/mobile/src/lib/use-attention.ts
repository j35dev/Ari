import { useEffect, useState } from 'react'
import type { RemoteAttention } from '@ari/contracts/remote'
import { useApp } from './app-state'

export interface Attention {
  /** Sessions waiting on the user; `null` when the desktop cannot list them. */
  items: RemoteAttention['items'] | null
  loading: boolean
  failure: string | null
}

/** Fetch every authorized page; a partial list must never claim nothing is blocked. */
export function useAttention(): Attention {
  const app = useApp()
  const [state, setState] = useState<Attention>({ items: [], loading: true, failure: null })
  useEffect(() => {
    const session = app.session
    if (session === null || !session.usable) return
    if (!session.supports('attention.list')) {
      setState({ items: null, loading: false, failure: null })
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const collected: RemoteAttention['items'] = []
        const seen = new Set<string>()
        let cursor: string | null = null
        do {
          const page: RemoteAttention = await session.query<RemoteAttention>(
            'attention.list',
            cursor === null ? {} : { cursor },
          )
          if (cancelled) return
          collected.push(...page.items)
          cursor = page.nextCursor
          if (cursor !== null && seen.has(cursor))
            throw new Error('The desktop returned an incomplete list of what needs you.')
          if (cursor !== null) seen.add(cursor)
        } while (cursor !== null)
        setState({
          items: collected.sort((a, b) => b.updatedAt - a.updatedAt),
          loading: false,
          failure: null,
        })
      } catch (error) {
        if (!cancelled)
          setState((current) => ({
            items: current.items,
            loading: false,
            failure: error instanceof Error ? error.message : 'Could not check what needs you.',
          }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [app.session, app.sessions, app.connection])
  return state
}
