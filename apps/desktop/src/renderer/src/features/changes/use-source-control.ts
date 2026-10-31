import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GitComparison,
  GitScope,
  GitReviewManifest,
  SourceControlContext,
} from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'

const log = createLogger('ui:source-control')
interface State {
  key: string
  context: SourceControlContext | null
  manifest: GitReviewManifest | null
  error: string | null
  watchError: string | null
  loading: boolean
}
const empty = (key: string): State => ({
  key,
  context: null,
  manifest: null,
  error: null,
  watchError: null,
  loading: false,
})

/** Single-flight, visibility-scoped reads; coalesce changes and ignore obsolete scope/selection replies. */
export function useSourceControl(scope: GitScope | null, comparison: GitComparison | null) {
  const scopeKey = JSON.stringify(scope)
  const comparisonKey = JSON.stringify(comparison)
  const key = `${scopeKey}:${comparisonKey}`
  const [state, setState] = useState<State>(() => empty(key))
  const reload = useRef<() => void>(() => undefined)
  const refresh = useCallback(() => reload.current(), [])
  useEffect(() => {
    if (!scope) return
    let closed = false
    let pending = false
    let dirty = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let ids: string[] = []
    const update = (patch: Partial<State>): void => {
      if (!closed)
        setState((current) => ({ ...(current.key === key ? current : empty(key)), ...patch, key }))
    }
    const load = async (): Promise<void> => {
      if (closed) return
      if (pending) {
        dirty = true
        return
      }
      pending = true
      update({ loading: true, error: null })
      ids = [crypto.randomUUID(), crypto.randomUUID()]
      try {
        const [context, manifest] = await Promise.all([
          rpc.invoke('scm.status', { ...scope, requestId: ids[0] }),
          comparison
            ? rpc.invoke('scm.review', { ...scope, comparison, requestId: ids[1] })
            : Promise.resolve(null),
        ])
        update({
          context: context.ok ? context.value : null,
          manifest: manifest?.ok ? manifest.value : null,
          error: !context.ok
            ? context.error.message
            : manifest && !manifest.ok
              ? manifest.error.message
              : null,
          loading: false,
        })
      } catch (error) {
        log.warn('Source-control read failed', { error: String(error) })
        update({
          context: null,
          manifest: null,
          error: 'Could not read this worktree. Refresh to retry.',
          loading: false,
        })
      } finally {
        pending = false
        ids = []
        if (dirty && !closed) {
          dirty = false
          timer = setTimeout(() => {
            timer = undefined
            void load()
          }, 300)
        }
      }
    }
    const invalidate = (): void => {
      if (document.hidden || timer) return
      timer = setTimeout(() => {
        timer = undefined
        void load()
      }, 300)
    }
    const subscribe = () =>
      rpc.subscribe('scm.changed', scope, (payload) => {
        const error =
          typeof payload === 'object' && payload !== null && 'error' in payload
            ? payload.error
            : null
        if (typeof error === 'string') update({ watchError: error })
        else invalidate()
      })
    let off = subscribe()
    const manual = (): void => {
      off()
      off = subscribe()
      update({ watchError: null })
      void load()
    }
    reload.current = manual
    window.addEventListener('focus', invalidate)
    document.addEventListener('visibilitychange', invalidate)
    void load()
    return () => {
      closed = true
      off()
      clearTimeout(timer)
      window.removeEventListener('focus', invalidate)
      document.removeEventListener('visibilitychange', invalidate)
      if (reload.current === manual) reload.current = () => undefined
      for (const requestId of ids)
        void rpc
          .invoke('scm.cancel', { requestId })
          .catch((error: unknown) => log.warn('Read cancellation failed', { error: String(error) }))
    }
  }, [scopeKey, comparisonKey])
  return { ...(scope && state.key === key ? state : { ...empty(key), loading: !!scope }), refresh }
}
