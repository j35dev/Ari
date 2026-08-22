import { useCallback, useEffect, useRef } from 'react'
import { useToast } from '@ari/ui/toast'
import type { ToastOptions } from '@ari/ui/toast'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('moment:settle')

/** Latest known visibility; kept in module state by {@link installVisibilityGuard}. */
let latestVisibility: DocumentVisibilityState =
  typeof document === 'undefined' ? 'visible' : document.visibilityState

/** Dispatcher registered while a {@link useSettleNotify} consumer is mounted. */
let toastDispatcher: ((opts: ToastOptions) => void) | null = null

/**
 * Cached window visibility maintained by the guard. Pure read — does not
 * consult the DOM, so it is safe to assert on directly.
 */
export function currentVisibility(): DocumentVisibilityState {
  return latestVisibility
}

function isWindowHidden(): boolean {
  if (typeof document !== 'undefined') return document.visibilityState === 'hidden'
  return latestVisibility === 'hidden'
}

/**
 * Track window visibility (visibilitychange + focus normalization) into module
 * state so non-DOM consumers and edge cases keep a reliable answer. Returns a
 * cleanup that removes both listeners.
 */
export function installVisibilityGuard(): () => void {
  const sync = (): void => {
    if (typeof document !== 'undefined') latestVisibility = document.visibilityState
  }
  const markVisible = (): void => {
    latestVisibility = 'visible'
  }
  document.addEventListener('visibilitychange', sync)
  window.addEventListener('focus', markVisible)
  sync()
  return () => {
    document.removeEventListener('visibilitychange', sync)
    window.removeEventListener('focus', markVisible)
  }
}

export interface SettleNotifyOptions {
  /** Toast dispatcher override (tests, callers outside ToastProvider). */
  toast?: (opts: ToastOptions) => void
}

/**
 * Fire a "session settled" toast — only when the window is hidden. Deliberately
 * side-effect-free otherwise: no subscriptions, no timers. Returns whether a
 * notification was emitted.
 */
export function notifySettled(title: string, options?: SettleNotifyOptions): boolean {
  if (!isWindowHidden()) return false
  const emit = options?.toast ?? toastDispatcher
  if (!emit) {
    log.warn('settle notification dropped: no toast dispatcher registered', { title })
    return false
  }
  emit({ title, description: 'Turn complete.', tone: 'info' })
  return true
}

/**
 * Wire settle notifications into React: installs the visibility guard for the
 * mount lifetime and returns a callback that notifies with the session title
 * resolved at call time. Subscribes to nothing — callers decide when a turn
 * settles.
 */
export function useSettleNotify(sessionTitleProvider: () => string): () => void {
  const { toast } = useToast()
  const titleProviderRef = useRef(sessionTitleProvider)
  titleProviderRef.current = sessionTitleProvider

  useEffect(() => {
    toastDispatcher = toast
    const disposeGuard = installVisibilityGuard()
    return () => {
      disposeGuard()
      if (toastDispatcher === toast) toastDispatcher = null
    }
  }, [toast])

  return useCallback(() => {
    notifySettled(titleProviderRef.current(), { toast })
  }, [toast])
}
