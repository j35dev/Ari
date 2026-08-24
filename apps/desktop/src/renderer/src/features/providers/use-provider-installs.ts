import { useCallback, useEffect, useRef, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { ProvidersUpdateFrame, RpcResults } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'

type Detection = RpcResults['providers.detect'][number]

export interface InstallState {
  operation: 'install' | 'upgrade'
  /** Live output lines, newest last; capped by the runner's tail. */
  lines: { stream: 'stdout' | 'stderr'; text: string }[]
  /** Set once the settle frame arrives; null while still running. */
  outcome: { ok: boolean; reason: string | null; truncated: boolean } | null
}

export type InstallStates = Partial<Record<DriverKind, InstallState>>

/** Auto-clears a finished install's output pane after this long. */
const SETTLED_DISPLAY_MS = 12_000

/**
 * Streams `providers.updates` frames into per-kind install state and exposes
 * the plan/run/cancel actions behind the confirm gate.
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
      if (frame.type === 'install.progress') {
        setInstalls((current) => {
          const state = current[frame.kind]
          if (state === undefined) return current
          return {
            ...current,
            [frame.kind]: {
              ...state,
              lines: [...state.lines.slice(-200), { stream: frame.stream, text: frame.text }],
            },
          }
        })
        return
      }
      if (frame.type === 'install.settled') {
        setInstalls((current) => ({
          ...current,
          [frame.kind]: current[frame.kind] === undefined
            ? current[frame.kind]
            : {
                ...current[frame.kind] as InstallState,
                outcome: { ok: frame.ok, reason: frame.reason, truncated: frame.truncated },
              },
        }))
      }
    })
    return unsubscribe
  }, [])

  // Settled panes fade out so a finished install doesn't clutter forever.
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
      [kind]: { operation, lines: [], outcome: null },
    }))
    const result = await rpc.invoke('providers.install', { kind, operation })
    if (!result.started) {
      // Rejected (already running / no channel): drop the placeholder pane and
      // surface the reason through the same outcome shape the card renders.
      setInstalls((current) => ({
        ...current,
        [kind]: {
          operation,
          lines: [],
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
