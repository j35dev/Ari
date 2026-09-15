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
    .catch(() => {
      // An app that cannot register a worker still works; it simply needs the
      // network to open, which is the state it was in before.
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

/** A small, dismissible banner rather than a reload the user did not ask for. */
export function UpdateBanner({ onApply, onDismiss }: { onApply: () => void; onDismiss: () => void }): ReactNode {
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-accent bg-accent-subtle px-4 py-2 text-xs"
    >
      <span className="flex-1">A new version of Ari is ready.</span>
      <button type="button" onClick={onApply} className="min-h-9 rounded-md bg-accent px-3 text-fg-on-accent">
        Reload
      </button>
      <button type="button" onClick={onDismiss} className="min-h-9 px-2 text-fg-muted">
        Later
      </button>
    </div>
  )
}
