import { useEffect, useMemo, useState } from 'react'
import { sourceControlSchemas } from '@ari/contracts/rpc'
import type { GitComparison } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('ui:review-preferences')
interface Preferences {
  comparison: GitComparison
  path: string | null
  filter: string
  scroll: Record<string, number>
}
const defaults = (): Preferences => ({
  comparison: { kind: 'working-tree' },
  path: null,
  filter: '',
  scroll: {},
})
function load(key: string): Preferences {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (typeof raw !== 'object' || raw === null) return defaults()
    const value = raw as Record<string, unknown>
    const comparison = sourceControlSchemas.comparison.safeParse(value['comparison'])
    const path = sourceControlSchemas.path.safeParse(value['path'])
    const scroll =
      typeof value['scroll'] === 'object' && value['scroll'] !== null
        ? (Object.fromEntries(
            Object.entries(value['scroll'])
              .slice(-100)
              .filter(
                ([path, offset]) =>
                  sourceControlSchemas.path.safeParse(path).success &&
                  typeof offset === 'number' &&
                  Number.isFinite(offset) &&
                  offset >= 0,
              ),
          ) as Record<string, number>)
        : {}
    return {
      comparison: comparison.success ? comparison.data : { kind: 'working-tree' },
      path: path.success ? path.data : null,
      filter: typeof value['filter'] === 'string' ? value['filter'].slice(0, 256) : '',
      scroll,
    }
  } catch (error) {
    log.warn('Review preferences unavailable', { error: String(error) })
    return defaults()
  }
}

/** Retains scope/file/filter/scroll per session without rerendering on every scroll frame. */
export function useReviewPreferences(scopeKey: string) {
  const [, render] = useState(0)
  const store = useMemo(() => {
    const key = `ari:review:${scopeKey}`
    const value = load(key)
    return {
      key,
      value,
      positions: new Map(Object.entries(value.scroll)),
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  }, [scopeKey])
  const persist = (): void => {
    try {
      sessionStorage.setItem(
        store.key,
        JSON.stringify({ ...store.value, scroll: Object.fromEntries(store.positions) }),
      )
    } catch (error) {
      log.warn('Review preferences could not be saved', { error: String(error) })
    }
  }
  useEffect(() => {
    persist()
  }, [store, store.value])
  useEffect(
    () => () => {
      clearTimeout(store.timer)
      persist()
    },
    [store],
  )
  return {
    value: store.value,
    change: (patch: Partial<Omit<Preferences, 'scroll'>>) => {
      store.value = { ...store.value, ...patch }
      render((value) => value + 1)
    },
    offset: (path: string) => store.positions.get(path) ?? 0,
    recordScroll: (path: string, offset: number) => {
      store.positions.delete(path)
      store.positions.set(path, offset)
      if (store.positions.size > 100) store.positions.delete(store.positions.keys().next().value!)
      clearTimeout(store.timer)
      store.timer = setTimeout(persist, 200)
    },
  }
}
