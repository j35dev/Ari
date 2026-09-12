import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppUpdateFrame } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'

const log = createLogger('updates:app')

/** Coarse stage of the update, from the renderer's point of view. */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  /** Checked, and this build is the newest one. */
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface AppUpdateState {
  /** Version running right now; null until `app.info` resolves. */
  currentVersion: string | null
  phase: UpdatePhase
  /** Offered by a check but not yet downloaded. */
  availableVersion: string | null
  /** Downloaded and waiting on a restart. */
  stagedVersion: string | null
  /** Download completion, 0–100, while `phase` is `downloading`. */
  progress: number | null
  /** Last failure, cleared as soon as a fresh check or download starts. */
  error: string | null
}

const INITIAL: AppUpdateState = {
  currentVersion: null,
  phase: 'idle',
  availableVersion: null,
  stagedVersion: null,
  progress: null,
  error: null,
}

/**
 * Reduces a stream frame onto the standing state. `available` also carries the
 * running version, which is the same one `app.info` reports — the frame is
 * preferred so a check that lands first cannot be contradicted later.
 */
export function reduceUpdateFrame(state: AppUpdateState, frame: AppUpdateFrame): AppUpdateState {
  switch (frame.type) {
    case 'checking':
      return { ...state, phase: 'checking', error: null }
    case 'none':
      return { ...INITIAL, currentVersion: state.currentVersion, phase: 'current' }
    case 'available':
      return {
        ...state,
        currentVersion: frame.currentVersion,
        phase: 'available',
        availableVersion: frame.version,
        stagedVersion: null,
        progress: null,
        error: null,
      }
    case 'download.started':
      return { ...state, phase: 'downloading', progress: 0, error: null }
    case 'download.progress':
      return { ...state, phase: 'downloading', progress: frame.percent }
    case 'downloaded':
      return {
        ...state,
        phase: 'ready',
        availableVersion: null,
        stagedVersion: frame.version,
        progress: null,
        error: null,
      }
    case 'error':
      return { ...state, phase: 'error', error: frame.message }
  }
}

export interface AppUpdate extends AppUpdateState {
  /** Ask the main process to look for a release now. */
  check: () => Promise<void>
  /** Download the offered release. */
  download: () => Promise<void>
  /** Relaunch into the staged release. The app restarts; nothing follows. */
  install: () => Promise<void>
}

/**
 * Live update state for the desktop shell. One subscription serves both the
 * Settings row and the toast, so the two can never disagree about which
 * version is on offer.
 */
export function useAppUpdate(): AppUpdate {
  const [state, setState] = useState<AppUpdateState>(INITIAL)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    let cancelled = false
    void rpc
      .invoke('app.info')
      .then((info) => {
        if (!cancelled) setState((prev) => ({ ...prev, currentVersion: info.version }))
      })
      .catch((error: unknown) => log.warn('app.info failed', { error }))

    const unsubscribe = rpc.subscribe('app.updates', {}, (payload) => {
      if (!cancelled) setState((prev) => reduceUpdateFrame(prev, payload as AppUpdateFrame))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  /**
   * A refusal (`started: false`) is an ordinary answer, not an exception, so
   * it surfaces as the state's error rather than a rejected promise.
   */
  const start = useCallback(
    async (method: 'app.update.check' | 'app.update.download' | 'app.update.install') => {
      try {
        const result = await rpc.invoke(method)
        if (!result.started) setState((prev) => ({ ...prev, error: result.reason }))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('update rpc failed', { method, error: message })
        setState((prev) => ({ ...prev, error: message }))
      }
    },
    [],
  )

  const check = useCallback(() => start('app.update.check'), [start])
  const download = useCallback(() => start('app.update.download'), [start])
  const install = useCallback(() => start('app.update.install'), [start])

  return { ...state, check, download, install }
}
