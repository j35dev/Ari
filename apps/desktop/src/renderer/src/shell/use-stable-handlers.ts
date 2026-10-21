import { useLayoutEffect, useRef } from 'react'

type Handler = (...args: never[]) => unknown

/**
 * Returns `props` with every `on*` function swapped for a stable stand-in that
 * calls the latest one. A memoised child then re-renders only when its data
 * changes, not whenever the parent re-creates its inline event handlers.
 * Non-handler functions (getters such as `activityOf`) are left as they are:
 * their identity is how a change in what they return reaches the child.
 */
export function useStableHandlers<T extends object>(props: T): T {
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })
  const stable = useRef(new Map<string, Handler>())
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    if (!key.startsWith('on') || typeof value !== 'function') {
      out[key] = value
      continue
    }
    let handler = stable.current.get(key)
    if (handler === undefined) {
      handler = (...args: never[]) => {
        const current = (latest.current as Record<string, unknown>)[key]
        return typeof current === 'function' ? (current as Handler)(...args) : undefined
      }
      stable.current.set(key, handler)
    }
    out[key] = handler
  }
  return out as T
}
