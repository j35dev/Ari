import { useSyncExternalStore } from 'react'

/**
 * The in-app "Reduce motion" switch, as shared state. It has to reach two
 * places that cannot read the settings store themselves: the stylesheet
 * (through `data-ari-reduce-motion` on `<html>`, see motion.css) and
 * `MotionProvider` (for `motion/react` components). The OS preference is
 * separate and always honoured; this only ever adds to it.
 */

let reduced = false
const listeners = new Set<() => void>()

/** Turns reduced motion on or off for the whole renderer, immediately. */
export function setReducedMotion(next: boolean): void {
  if (next) document.documentElement.dataset['ariReduceMotion'] = ''
  else delete document.documentElement.dataset['ariReduceMotion']
  if (reduced === next) return
  reduced = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether the in-app switch is on. Re-renders when it changes. */
export function useReducedMotionSetting(): boolean {
  return useSyncExternalStore(subscribe, () => reduced)
}
