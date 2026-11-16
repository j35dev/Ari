import { useEffect, useRef } from 'react'
import { subscribeDraftIntent } from '../composer/draft-recovery-store'
import { useEngineSettings } from '../settings/useEngineSettings'
import { attachSnapshot } from './attach'

export function useSnapshots(
  resolveTarget: (pinned?: string) => string | null,
  notify: (message: string) => void,
): void {
  const { settings } = useEngineSettings()
  const current = useRef({ resolveTarget, notify, settings })
  current.current = { resolveTarget, notify, settings }
  const drainRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    const bridge = window.ari?.snapshots
    if (!bridge) return
    let disposed = false
    let busy = false
    let again = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastError: string | null = null
    const drain = async (): Promise<void> => {
      if (disposed || !current.current.settings) return
      if (busy) {
        again = true
        return
      }
      busy = true
      try {
        let failure: string | null = null
        do {
          again = false
          for (const item of await bridge.pending()) {
            if (disposed) return
            // One unattachable capture must not hold back the rest of the queue.
            try {
              // A pinned draft can disappear (a sent project draft, an archived
              // chat); re-pin to the current destination instead of waiting forever.
              const target =
                current.current.resolveTarget(item.target) ??
                (item.target ? current.current.resolveTarget() : null)
              if (!target) throw new Error('Open a project or chat to attach your saved SnapShot.')
              const pinned = await bridge.target(item.id, target)
              const capture = await bridge.read(item.id)
              if (disposed) return
              attachSnapshot(capture, pinned, current.current.settings.snapshots)
              if (capture.desktopFeedback)
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    if (disposed || document.visibilityState !== 'visible') return
                    const image = [
                      ...document.querySelectorAll<HTMLImageElement>(
                        `[data-snapshot-id="${capture.id}"]`,
                      ),
                    ].find((candidate) => {
                      const rectangle = candidate.getBoundingClientRect()
                      return (
                        rectangle.width > 0 &&
                        document.elementFromPoint(
                          rectangle.x + rectangle.width / 2,
                          rectangle.y + rectangle.height / 2,
                        ) === candidate
                      )
                    })
                    const rectangle = image?.getBoundingClientRect()
                    if (rectangle && rectangle.width > 0 && rectangle.height > 0)
                      void bridge
                        .destination(capture.id, {
                          x: rectangle.x,
                          y: rectangle.y,
                          width: rectangle.width,
                          height: rectangle.height,
                        })
                        .catch(() => undefined)
                  }),
                )
              await bridge.acknowledge(item.id)
            } catch (error) {
              failure ??= error instanceof Error ? error.message : String(error)
            }
          }
        } while (again && !disposed)
        if (failure && !disposed && lastError !== failure) current.current.notify(failure)
        lastError = failure
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!disposed && lastError !== message) current.current.notify(message)
        lastError = message
      } finally {
        busy = false
      }
    }
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        void drain()
      }, 100)
    }
    drainRef.current = schedule
    const unsubscribe = bridge.onEvent((event) => {
      if (event.type === 'error') current.current.notify(event.message)
      else schedule()
    })
    const unsubscribeDrafts = subscribeDraftIntent(schedule)
    schedule()
    return () => {
      disposed = true
      clearTimeout(timer)
      unsubscribe()
      unsubscribeDrafts()
      drainRef.current = () => undefined
    }
  }, [])
  // Startup inventory, settings hydration and navigation can make a saved
  // capture's destination available without another capture event.
  useEffect(() => {
    drainRef.current()
  }, [resolveTarget, settings])
}
