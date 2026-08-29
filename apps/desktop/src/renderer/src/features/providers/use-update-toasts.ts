import { useEffect, useRef } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { ProvidersUpdateFrame, RpcResults } from '@ari/contracts/rpc'
import { useToast } from '@ari/ui/toast'
import { rpc } from '../../lib/rpc'

type Detections = RpcResults['providers.detect']

/** Grace after launch so the toast never races the boot splash's own scan. */
const GRACE_MS = 30_000

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

    const announce = (detections: Detections): void => {
      if (cancelled) return
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
            onClick: () => {
              inflight.add(kind)
              toastApi.current.update(id, {
                title: `Updating ${capitalize(kind)}…`,
                description: 'Installing the latest CLI. Settings will refresh when it lands.',
                tone: 'info',
                durationMs: 0,
                action: undefined,
              })
              void rpc.invoke('providers.install', { kind, operation: 'upgrade' }).then((result) => {
                if (result.started) return
                inflight.delete(kind)
                toastApi.current.update(id, {
                  title: `Could not update ${capitalize(kind)}`,
                  description: result.reason ?? 'An operation is already running.',
                  tone: 'danger',
                  durationMs: 10_000,
                })
              })
            },
          },
        })
        toastByKind.set(kind, id)
      }
    }

    const settleToast = (frame: Extract<ProvidersUpdateFrame, { type: 'install.settled' }>): void => {
      inflight.delete(frame.kind)
      const id = toastByKind.get(frame.kind)
      toastByKind.delete(frame.kind)
      const name = capitalize(frame.kind)
      const version = versionLabel(frame.version)
      const payload = frame.ok
        ? {
            title: frame.operation === 'install' ? `${name} installed` : `${name} is up to date`,
            description: version ?? (frame.operation === 'install' ? 'Ready to use.' : 'Settings refreshed.'),
            tone: 'success' as const,
            durationMs: 6_000,
            action: undefined,
          }
        : {
            title: frame.operation === 'install' ? `Could not install ${name}` : `Could not update ${name}`,
            description: frame.reason ?? 'The command finished without applying the new version.',
            tone: 'danger' as const,
            durationMs: 12_000,
            action: undefined,
          }
      if (id !== undefined && toastApi.current.update(id, payload)) return
      toastApi.current.toast(payload)
    }

    const unsubscribe = rpc.subscribe('providers.updates', {}, (payload) => {
      const frame = payload as ProvidersUpdateFrame
      if (frame.type === 'detections') announce(frame.detections)
      if (frame.type === 'install.settled') settleToast(frame)
    })
    const grace = setTimeout(() => {
      void rpc.invoke('providers.detect').then(announce).catch(() => undefined)
    }, GRACE_MS)

    return () => {
      cancelled = true
      clearTimeout(grace)
      unsubscribe()
    }
  }, [])
}
