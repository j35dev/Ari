import { useEffect, useRef } from 'react'
import type { ProvidersUpdateFrame, RpcResults } from '@ari/contracts/rpc'
import { useToast } from '@ari/ui/toast'
import { rpc } from '../../lib/rpc'

type Detections = RpcResults['providers.detect']

/** Grace after launch so the toast never races the boot splash's own scan. */
const GRACE_MS = 30_000

/**
 * Announces provider updates as toasts: one per kind per version per launch
 * (the in-memory seen-set caps it), gated on a 30s post-launch grace so it
 * never races the boot scan. The Providers settings card remains the surface
 * where updates are actually acted on.
 */
export function useUpdateToasts(): void {
  const { toast } = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast

  useEffect(() => {
    let cancelled = false
    const seen = new Set<string>()

    const announce = (detections: Detections): void => {
      if (cancelled) return
      for (const detection of detections) {
        if (detection.updateAvailable !== true || detection.latestVersion == null) continue
        const key = `${detection.kind}@${detection.latestVersion}`
        if (seen.has(key)) continue
        seen.add(key)
        toastRef.current({
          title: `${capitalize(detection.kind)} ${detection.latestVersion} available`,
          description: 'Update now, without opening Settings.',
          tone: 'info',
          durationMs: 20_000,
          action: {
            label: 'Update',
            onClick: () => {
              void rpc.invoke('providers.install', {
                kind: detection.kind,
                operation: 'upgrade',
              })
            },
          },
        })
      }
    }

    // Boot publishes a detections frame once enrichment lands; the grace
    // fallback covers launches where that round already ran before mount.
    const unsubscribe = rpc.subscribe('providers.updates', {}, (payload) => {
      const frame = payload as ProvidersUpdateFrame
      if (frame.type === 'detections') announce(frame.detections)
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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
