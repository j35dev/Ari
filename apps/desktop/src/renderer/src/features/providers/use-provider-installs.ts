import { useCallback, useEffect, useRef, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { ProvidersUpdateFrame, RpcResults } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'

type Detection = RpcResults['providers.detect'][number]

export interface InstallState {
  operation: 'install' | 'upgrade'
  /** Set once the settle frame arrives; null while still running. */
  outcome: { ok: boolean; reason: string | null; truncated: boolean } | null
}

export type InstallStates = Partial<Record<DriverKind, InstallState>>

/** Auto-clears a finished install's status after this long. */
const SETTLED_DISPLAY_MS = 8_000

/**
 * Streams `providers.updates` frames into per-kind install state and exposes
 * the plan/run/cancel actions.
 *
 * `onDetections` fires whenever the main process publishes a fresh detection
 * round (including the mandatory post-install re-probe), so the caller's
 * grid stays current without polling.
 */
export function useProviderInstalls(onDetections: (detections: Detection[]) => void): {
  installs: InstallStates
  planFor: (kind: DriverKind) => Promise<RpcResults['providers.plan']>
  start: (kind: DriverKind, operation: 'install' | 'upgrade') => Promise<void>
  cancel: (kind: DriverKind) => Promise<void>
} {
  const [installs, setInstalls] = useState<InstallStates>({})
  const detectionsRef = useRef(onDetections)
  detectionsRef.current = onDetections

  useEffect(() => {
    const unsubscribe = rpc.subscribe('providers.updates', {}, (payload) => {
      const frame = payload as ProvidersUpdateFrame
      if (frame.type === 'detections') {
        detectionsRef.current(frame.detections)
        return
      }
      if (frame.type === 'install.started') {
        setInstalls((current) => ({
          ...current,
          [frame.kind]: { operation: frame.operation, outcome: null },
        }))
        return
      }
      if (frame.type === 'install.settled') {
        setInstalls((current) => ({
          ...current,
          [frame.kind]: {
            operation: frame.operation,
            outcome: { ok: frame.ok, reason: frame.reason, truncated: frame.truncated },
          },
        }))
      }
    })
    return unsubscribe
  }, [])

  // Settled status fades out so a finished install doesn't clutter forever.
  useEffect(() => {
    const settled = Object.entries(installs).filter(([, state]) => state?.outcome != null)
    if (settled.length === 0) return
    const timer = setTimeout(() => {
      setInstalls((current) => {
        const next = { ...current }
        for (const kind of settled.map(([entryKind]) => entryKind)) {
          if (next[kind as DriverKind]?.outcome != null) delete next[kind as DriverKind]
        }
        return next
      })
    }, SETTLED_DISPLAY_MS)
    return () => clearTimeout(timer)
  }, [installs])

  const planFor = useCallback(
    (kind: DriverKind) => rpc.invoke('providers.plan', { kind }),
    [],
  )

  const start = useCallback(async (kind: DriverKind, operation: 'install' | 'upgrade') => {
    setInstalls((current) => ({
      ...current,
      [kind]: { operation, outcome: null },
    }))
    const result = await rpc.invoke('providers.install', { kind, operation })
    if (!result.started) {
      setInstalls((current) => ({
        ...current,
        [kind]: {
          operation,
          outcome: { ok: false, reason: result.reason ?? 'Could not start.', truncated: false },
        },
      }))
    }
  }, [])

  const cancel = useCallback(async (kind: DriverKind) => {
    await rpc.invoke('providers.cancelInstall', { kind })
  }, [])

  return { installs, planFor, start, cancel }
}
