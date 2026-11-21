/**
 * Whether setup currently covers the window. The gate writes it; surfaces that
 * would otherwise talk over setup (update toasts) read it and hold back.
 *
 * It starts true: until the gate has decided whether setup shows, a first run
 * is still possible, and anything announced in that window would land on it.
 */
let shown = true
const listeners = new Set<(shown: boolean) => void>()

export function isOnboardingShown(): boolean {
  return shown
}

export function setOnboardingShown(next: boolean): void {
  if (next === shown) return
  shown = next
  for (const listener of [...listeners]) listener(next)
}

/** Calls `listener` on every change; returns the unsubscribe. */
export function onOnboardingShownChange(listener: (shown: boolean) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
