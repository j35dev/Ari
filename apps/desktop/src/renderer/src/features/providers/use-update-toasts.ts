import { useEffect, useRef } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { ProvidersUpdateFrame, RpcResults } from '@ari/contracts/rpc'
import { useToast } from '@ari/ui/toast'
import { rpc } from '../../lib/rpc'
import {
  isOnboardingShown,
  onOnboardingShownChange,
  wasSetupDisplayed,
} from '../onboarding/onboarding-presence'

type Detections = RpcResults['providers.detect']

/** Grace after launch so the toast never races the boot splash's own scan. */
const GRACE_MS = 30_000
/** After a setup the user went through, their first minutes in the workspace stay quiet. */
export const AFTER_SETUP_QUIET_MS = 90_000

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function versionLabel(version: string | null | undefined): string | null {
  if (version == null || version.length === 0) return null
  return version
}

/**
 * Announces provider updates as toasts (T3-style, top-right): one per kind per
 * version per launch. Clicking Update runs the upgrade in place, then the
 * settle frame refreshes the toast and Settings auto-syncs the new version.
 *
 * Setup speaks for itself: while it covers the window, availability is held
 * back until it closes, and installs started there report only on its stage.
 */
export function useUpdateToasts(): void {
  const { toast, update } = useToast()
  const toastApi = useRef({ toast, update })
  toastApi.current = { toast, update }

  useEffect(() => {
    let cancelled = false
    const seen = new Set<string>()
    const toastByKind = new Map<DriverKind, number>()
    const inflight = new Set<DriverKind>()
    const settledKinds = new Set<DriverKind>()
    /** Installs started while setup was shown; setup reports them itself. */
    const quietKinds = new Set<DriverKind>()
    let deferred: Detections | null = null
    let quietUntil = 0
    let quietTimer: ReturnType<typeof setTimeout> | undefined

    const run = (kind: DriverKind, operation: 'install' | 'upgrade', id: number): void => {
      if (inflight.has(kind)) return
      inflight.add(kind)
      settledKinds.delete(kind)
      toastByKind.set(kind, id)
      toastApi.current.update(id, {
        title: `Updating ${capitalize(kind)}…`,
        description: 'Preparing the updater…',
        tone: 'info',
        durationMs: 0,
        action: undefined,
      })
      const failed = (reason: string): void => {
        inflight.delete(kind)
        toastApi.current.update(id, {
          title: `Could not update ${capitalize(kind)}`,
          description: reason,
          tone: 'danger',
          durationMs: 0,
          dismissOnAction: false,
          action: { label: 'Retry', onClick: () => run(kind, operation, id) },
        })
      }
      void rpc
        .invoke('providers.install', { kind, operation })
        .then((result) => {
          if (!result.started)
            failed(result.reason ?? 'The updater could not start. Retry shortly.')
        })
        .catch(() => failed('The update request failed. Retry to reconnect.'))
    }

    const announce = (detections: Detections): void => {
      if (cancelled) return
      if (isOnboardingShown()) {
        deferred = detections
        return
      }
      const wait = quietUntil - Date.now()
      if (wait > 0) {
        deferred = detections
        clearTimeout(quietTimer)
        quietTimer = setTimeout(() => {
          const held = deferred
          deferred = null
          if (held) announce(held)
        }, wait)
        return
      }
      for (const detection of detections) {
        if (detection.updateAvailable !== true || detection.latestVersion == null) continue
        const kind = detection.kind as DriverKind
        if (inflight.has(kind)) continue
        const key = `${kind}@${detection.latestVersion}`
        if (seen.has(key)) continue
        seen.add(key)
        const id = toastApi.current.toast({
          title: `${capitalize(kind)} ${detection.latestVersion} available`,
          description: 'Update now, without opening Settings.',
          tone: 'info',
          durationMs: 0,
          dismissOnAction: false,
          action: {
            label: 'Update',
            onClick: () => run(kind, 'upgrade', id),
          },
        })
        toastByKind.set(kind, id)
      }
    }

    const settleToast = (
      frame: Extract<ProvidersUpdateFrame, { type: 'install.settled' }>,
    ): void => {
      if (settledKinds.has(frame.kind)) return
      settledKinds.add(frame.kind)
      inflight.delete(frame.kind)
      const id = toastByKind.get(frame.kind)
      const name = capitalize(frame.kind)
      const version = versionLabel(frame.version)
      const payload = frame.ok
        ? {
            title: frame.operation === 'install' ? `${name} installed` : `${name} updated`,
            description:
              version ?? (frame.operation === 'install' ? 'Ready to use.' : 'Settings refreshed.'),
            tone: 'success' as const,
            durationMs: 6_000,
            action: undefined,
          }
        : {
            title:
              frame.operation === 'install'
                ? `Could not install ${name}`
                : `Could not update ${name}`,
            description: frame.reason ?? 'The command finished without applying the new version.',
            tone: 'danger' as const,
            durationMs: 0,
            dismissOnAction: false,
            action: {
              label: 'Retry',
              onClick: () => {
                const retryId = toastByKind.get(frame.kind)
                if (retryId !== undefined) run(frame.kind, frame.operation, retryId)
              },
            },
          }
      if (id !== undefined && toastApi.current.update(id, payload)) return
      toastByKind.set(frame.kind, toastApi.current.toast(payload))
    }

    const unsubscribe = rpc.subscribe('providers.updates', {}, (payload) => {
      const frame = payload as ProvidersUpdateFrame
      if (frame.type === 'detections') announce(frame.detections)
      if (frame.type === 'install.started' && isOnboardingShown() && !toastByKind.has(frame.kind))
        quietKinds.add(frame.kind)
      if (frame.type !== 'detections' && 'kind' in frame && quietKinds.has(frame.kind)) {
        if (frame.type === 'install.settled') quietKinds.delete(frame.kind)
        return
      }
      if (frame.type === 'install.started') {
        settledKinds.delete(frame.kind)
        inflight.add(frame.kind)
        const payload = {
          title: `${frame.operation === 'install' ? 'Installing' : 'Updating'} ${capitalize(frame.kind)}…`,
          description: 'Preparing the updater…',
          tone: 'info' as const,
          durationMs: 0,
          action: undefined,
          dismissOnAction: false,
        }
        const id = toastByKind.get(frame.kind)
        if (id === undefined || !toastApi.current.update(id, payload))
          toastByKind.set(frame.kind, toastApi.current.toast(payload))
      }
      if (frame.type === 'install.phase') {
        const id = toastByKind.get(frame.kind)
        if (id !== undefined) toastApi.current.update(id, { description: frame.message })
      }
      if (frame.type === 'install.settled') settleToast(frame)
    })
    const grace = setTimeout(() => {
      void rpc
        .invoke('providers.detect')
        .then(announce)
        .catch(() => undefined)
    }, GRACE_MS)

    const unwatch = onOnboardingShownChange((shown) => {
      if (shown) return
      // The first session just appeared; let the user start before talking.
      if (wasSetupDisplayed()) quietUntil = Date.now() + AFTER_SETUP_QUIET_MS
      if (deferred === null) return
      const held = deferred
      deferred = null
      announce(held)
    })

    return () => {
      cancelled = true
      clearTimeout(grace)
      clearTimeout(quietTimer)
      unsubscribe()
      unwatch()
    }
  }, [])
}
