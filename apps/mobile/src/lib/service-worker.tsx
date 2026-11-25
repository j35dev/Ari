import type { ReactNode } from 'react'

/**
 * Service worker registration, and the one decision it implies: when to take
 * an update.
 *
 * The worker installs and then waits. Applying it is the user's call, because
 * the alternative is a reload in the middle of a prompt or an unanswered
 * approval — the two things on this screen a person would least like to lose.
 */

export interface UpdateHandle {
  /** Reloads onto the waiting version. */
  apply: () => void
}

let registration: ServiceWorkerRegistration | null = null

export function registerServiceWorker(onUpdateReady: () => void): void {
  if (!('serviceWorker' in navigator)) return
  // A dev server serves sources that a cache would shadow, which reads as a
  // change that never arrives.
  if (import.meta.env.DEV) return

  void navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then((registered) => {
      registration = registered
      if (registered.waiting !== null) onUpdateReady()
      registered.addEventListener('updatefound', () => {
        const installing = registered.installing
        if (installing === null) return
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller !== null) {
            onUpdateReady()
          }
        })
      })
    })
    .catch((error: unknown) => {
      console.warn('Ari could not enable offline app loading', error)
    })
}

/** Applies the waiting version and reloads once it is in control. */
export function applyUpdate(): void {
  const waiting = registration?.waiting
  if (waiting === undefined || waiting === null) {
    location.reload()
    return
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
    once: true,
  })
  waiting.postMessage({ type: 'ari.skip-waiting' })
}

/**
 * A small, dismissible note rather than a reload the user did not ask for.
 * It floats above the bottom edge: pinned to the top it sat under the status
 * bar and the notch, above the screen's own safe-area padding.
 */
export function UpdateBanner({
  onApply,
  onDismiss,
}: {
  onApply: () => void
  onDismiss: () => void
}): ReactNode {
  return (
    <div
      role="status"
      className="sheet-rise absolute inset-x-4 bottom-[calc(max(1.25rem,env(safe-area-inset-bottom))+4.25rem)] z-40 flex items-center gap-3 rounded-2xl border border-border bg-surface-2 py-1.5 pl-4 pr-1.5 text-xs shadow-[var(--ari-shadow-2)]"
    >
      <span className="flex-1">A new version of Ari is ready.</span>
      <button
        type="button"
        onClick={onApply}
        className="min-h-9 rounded-md bg-accent px-3 text-fg-on-accent"
      >
        Reload
      </button>
      <button type="button" onClick={onDismiss} className="min-h-9 px-2 text-fg-muted">
        Later
      </button>
    </div>
  )
}
