import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  navigateFrameSchema,
  appNavigationValidationSchema,
  type AppOpenFrame,
  type AppOpenReceipt,
  type AppOpenTarget,
} from '@ari/contracts/rpc'
import { rpc } from './lib/rpc'

interface Options {
  intent: string
  userIntent(): void
  prepare(target: AppOpenTarget): Promise<boolean>
  apply(target: AppOpenTarget): void
  observe(target: AppOpenTarget): AppOpenReceipt['observed']
}
interface Pending {
  frame: AppOpenFrame
  intent: string
  stage: 'loading' | 'observing'
}

/** A single mounted Shell acknowledges its committed selection, never provider readiness. */
export function useAppNavigation(options: Options): void {
  const latest = useRef(options)
  latest.current = options
  const consumerId = useRef(`shell_${crypto.randomUUID()}`).current
  const pending = useRef<Pending | null>(null)
  const mounted = useRef(false)
  const seen = useRef(new Set<string>())
  const [commit, setCommit] = useState(0)
  const finish = useRef((status: AppOpenReceipt['status'], reason?: AppOpenReceipt['reason']) => {
    const request = pending.current
    if (!request) return
    pending.current = null
    void rpc
      .invoke('app.navigation.ack', {
        consumerId,
        receipt: {
          requestId: request.frame.requestId,
          target: request.frame.target,
          status,
          reason,
        },
      })
      .catch(() => undefined)
  })

  useEffect(() => {
    mounted.current = true
    const unsubscribe = rpc.subscribe(
      'app.navigate',
      { navigationConsumerId: consumerId },
      (raw) => {
        const parsed = navigateFrameSchema.safeParse(raw)
        if (!parsed.success || !('kind' in parsed.data) || parsed.data.consumerId !== consumerId)
          return
        const frame = parsed.data
        if (frame.kind === 'app.open.cancel') {
          if (pending.current?.frame.requestId === frame.requestId) pending.current = null
          return
        }
        if (seen.current.has(frame.requestId)) return
        seen.current.add(frame.requestId)
        if (seen.current.size > 200) seen.current.delete(seen.current.values().next().value!)
        finish.current('superseded', 'new_request')
        const request: Pending = { frame, intent: latest.current.intent, stage: 'loading' }
        pending.current = request
        const current = () => mounted.current && pending.current === request
        void (async () => {
          try {
            if (Date.now() >= frame.expiresAt) {
              finish.current('stale', 'expired')
              return
            }
            const prepared = await latest.current.prepare(frame.target)
            if (!current()) return
            if (request.intent !== latest.current.intent) {
              finish.current('superseded', 'user_navigation')
              return
            }
            if (!prepared) {
              finish.current('stale', 'target_changed')
              return
            }
            const valid = appNavigationValidationSchema.parse(
              await rpc.invoke('app.navigation.validate', {
                consumerId,
                requestId: frame.requestId,
              }),
            )
            if (!current()) return
            if (!valid.allowed) {
              pending.current = null
              return
            }
            if (Date.now() >= frame.expiresAt) {
              finish.current('stale', 'expired')
              return
            }
            if (request.intent !== latest.current.intent) {
              finish.current('superseded', 'user_navigation')
              return
            }
            request.stage = 'observing'
            latest.current.apply(frame.target)
            setCommit((value) => value + 1)
          } catch {
            if (current()) finish.current('failed', 'load_failed')
          }
        })()
      },
    )
    void rpc
      .invoke('app.navigation.consumer', { consumerId, connected: true })
      .catch(() => undefined)
    const userIntent = () => {
      latest.current.userIntent()
      finish.current('superseded', 'user_navigation')
    }
    window.addEventListener('pointerdown', userIntent, true)
    window.addEventListener('keydown', userIntent, true)
    window.addEventListener('click', userIntent, true)
    return () => {
      mounted.current = false
      pending.current = null
      unsubscribe()
      window.removeEventListener('pointerdown', userIntent, true)
      window.removeEventListener('keydown', userIntent, true)
      window.removeEventListener('click', userIntent, true)
      void rpc
        .invoke('app.navigation.consumer', { consumerId, connected: false })
        .catch(() => undefined)
    }
  }, [consumerId])

  useLayoutEffect(() => {
    const request = pending.current
    if (!request) return
    if (Date.now() >= request.frame.expiresAt) {
      finish.current('stale', 'expired')
      return
    }
    if (request.stage === 'loading') {
      if (request.intent !== options.intent) finish.current('superseded', 'user_navigation')
      return
    }
    const observed = options.observe(request.frame.target)
    if (!observed) {
      finish.current('failed', 'observation_failed')
      return
    }
    pending.current = null
    void rpc
      .invoke('app.navigation.ack', {
        consumerId,
        receipt: {
          requestId: request.frame.requestId,
          target: request.frame.target,
          status: 'applied',
          observed,
        },
      })
      .catch(() => undefined)
  }, [options, commit, consumerId])
}
