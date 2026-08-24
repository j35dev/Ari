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
  /**
   * When set, the settle was a failure: the toast uses the danger tone and
   * fires even while the window is focused — errors are never silent.
   */
  error?: string | null
}

const MAX_ERROR_LENGTH = 220

function describeError(error: string): string {
  const flat = error.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_ERROR_LENGTH ? `${flat.slice(0, MAX_ERROR_LENGTH - 1)}…` : flat
}

/**
 * Fire a settle toast. Success settles notify only when the window is hidden;
 * error settles always notify. Returns whether a notification was emitted.
 */
export function notifySettled(title: string, options?: SettleNotifyOptions): boolean {
  const isError = Boolean(options?.error)
  if (!isError && !isWindowHidden()) return false
  const emit = options?.toast ?? toastDispatcher
  if (!emit) {
    log.warn('settle notification dropped: no toast dispatcher registered', { title })
    return false
  }
  emit(
    options?.error
      ? {
          title,
          description: `Turn failed — ${describeError(options.error)}`,
          tone: 'danger',
          durationMs: 8000,
        }
      : { title, description: 'Turn complete.', tone: 'info' },
  )
  return true
}

/**
 * Wire settle notifications into React: installs the visibility guard for the
 * mount lifetime and returns a callback that notifies with the session title
 * resolved at call time; callers may pass `{ error }` for failure settles.
 */
export function useSettleNotify(
  sessionTitleProvider: () => string,
): (payload?: { error?: string | null }) => void {
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

  return useCallback(
    (payload?: { error?: string | null }) => {
      notifySettled(titleProviderRef.current(), { toast, error: payload?.error })
    },
    [toast],
  )
}

export interface AttentionNotifyOptions {
  /** Toast dispatcher override (tests, callers outside ToastProvider). */
  toast?: (opts: ToastOptions) => void
  /** What is being waited on, e.g. the tool name or the question prompt. */
  detail?: string
}

/**
 * Fire an "agent needs you" toast for blocking states that would otherwise be
 * silent while away — pending approvals and questions. Only fires while the
 * window is hidden; a focused user sees the inline cards already.
 */
export function notifyNeedsAttention(
  title: string,
  options?: AttentionNotifyOptions,
): boolean {
  if (!isWindowHidden()) return false
  const emit = options?.toast ?? toastDispatcher
  if (!emit) return false
  emit({
    title,
    description: options?.detail
      ? `Waiting for you — ${options.detail}`
      : 'Waiting for your approval.',
    tone: 'warning',
  })
  return true
}
