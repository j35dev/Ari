import { useEffect, useRef } from 'react'
import type { AppUpdateFrame } from '@ari/contracts/rpc'
import { useToast, type ToastOptions } from '@ari/ui/toast'
import { rpc } from '../../lib/rpc'

/**
 * Announces a new Ari release and drives it end to end: offer, download with
 * progress, then a restart prompt. Every toast is sticky (`durationMs: 0`) —
 * an update is a decision, so nothing here times out on its own.
 *
 * Background-check failures stay silent; only failures the user is part of
 * (they clicked Update, or a download is running) reach the screen.
 */
export function useAppUpdateToast(): void {
  const { toast, update } = useToast()
  const toastApi = useRef({ toast, update })
  toastApi.current = { toast, update }

  useEffect(() => {
    let cancelled = false
    /** Versions already offered this launch, so a 6-hourly check stays quiet. */
    const offered = new Set<string>()
    /** Toast tracking the release the user is acting on, if any. */
    let activeId: number | null = null
    /** The release being downloaded; progress frames carry no version. */
    let activeVersion: string | null = null
    /** True once the user has asked for a download this launch. */
    let downloading = false
    let lastPercent = -1

    /** Rewrites the tracked toast, or posts a new one when it is gone. */
    const show = (patch: ToastOptions): void => {
      const current = activeId
      if (current !== null && toastApi.current.update(current, patch)) return
      activeId = toastApi.current.toast(patch)
    }

    const failDownload = (reason: string | null): void => {
      downloading = false
      show({
        title: 'Could not download the update',
        description: reason ?? 'The download stopped before it finished.',
        tone: 'danger',
        durationMs: 12_000,
        action: undefined,
      })
    }

    const failRestart = (reason: string | null): void => {
      show({
        title: 'Could not restart into the update',
        description: reason ?? 'Restart Ari to finish installing.',
        tone: 'danger',
        durationMs: 12_000,
        action: undefined,
      })
    }

    /** A thrown RPC is as much a refusal as a `started: false` reply. */
    const describe = (cause: unknown): string =>
      cause instanceof Error ? cause.message : String(cause)

    const onFrame = (frame: AppUpdateFrame): void => {
      if (cancelled) return
      switch (frame.type) {
        case 'available': {
          if (offered.has(frame.version)) return
          offered.add(frame.version)
          activeVersion = frame.version
          downloading = false
          lastPercent = -1
          show({
            title: `Ari ${frame.version} is available`,
            description: `You're on ${frame.currentVersion}.`,
            tone: 'info',
            durationMs: 0,
            dismissOnAction: false,
            action: {
              label: 'Update',
              onClick: () => {
                downloading = true
                lastPercent = -1
                show({
                  title: `Downloading Ari ${frame.version}…`,
                  description: 'Starting…',
                  tone: 'info',
                  durationMs: 0,
                  action: undefined,
                })
                void rpc
                  .invoke('app.update.download')
                  .then((result) => {
                    if (!result.started) failDownload(result.reason)
                  })
                  .catch((cause: unknown) => failDownload(describe(cause)))
              },
            },
          })
          return
        }
        case 'download.started':
          downloading = true
          activeVersion = frame.version
          lastPercent = -1
          show({
            title: `Downloading Ari ${frame.version}…`,
            description: 'Starting…',
            tone: 'info',
            durationMs: 0,
            action: undefined,
          })
          return
        case 'download.progress':
          // Progress arrives in bursts; only redraw on a whole percent.
          if (frame.percent === lastPercent) return
          lastPercent = frame.percent
          show({
            title: activeVersion === null ? 'Downloading update…' : `Downloading Ari ${activeVersion}…`,
            description: `${frame.percent}%`,
            tone: 'info',
            durationMs: 0,
            action: undefined,
          })
          return
        case 'downloaded':
          downloading = false
          activeVersion = frame.version
          offered.add(frame.version)
          show({
            title: `Ari ${frame.version} is ready`,
            description: 'Restart to finish installing.',
            tone: 'success',
            durationMs: 0,
            dismissOnAction: false,
            action: {
              label: 'Restart',
              onClick: () => {
                void rpc
                  .invoke('app.update.install')
                  .then((result) => {
                    if (result.started) return
                    failRestart(result.reason)
                  })
                  .catch((cause: unknown) => failRestart(describe(cause)))
              },
            },
          })
          return
        case 'error':
          // A failed background check stays in the log; only an error the user
          // is actively waiting on deserves a toast.
          if (downloading) failDownload(frame.message)
          return
        default:
          return
      }
    }

    const unsubscribe = rpc.subscribe('app.updates', {}, (payload) =>
      onFrame(payload as AppUpdateFrame),
    )
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
}
