import { AnimatePresence, motion } from 'motion/react'
import type { Variants } from 'motion/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { fadeUpVariants } from '@ari/ui/motion'

export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  title: string
  description?: string
  tone?: ToastTone
  durationMs?: number
  action?: ToastAction
}

interface ToastRecord {
  id: number
  title: string
  description?: string
  tone: ToastTone
  durationMs: number
  action?: ToastAction
}

/** Tone accent bar color; neutral borrows the accent-subtle token. */
const TONE_ACCENT_CLASSES: Record<ToastTone, string> = {
  neutral: 'border-l-accent-subtle',
  success: 'border-l-success',
  warning: 'border-l-warning',
  danger: 'border-l-danger',
  info: 'border-l-info',
}

const TOAST_VARIANTS: Variants = {
  ...fadeUpVariants,
  exit: { opacity: 0, y: 4, transition: { duration: 0.12, ease: 'easeIn' } },
}

const MAX_VISIBLE_TOASTS = 5
const DEFAULT_DURATION_MS = 4000

interface ToastContextValue {
  toast: (opts: ToastOptions) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

/** Access the toast queue; must be rendered inside {@link ToastProvider}. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

/**
 * Bottom-right toast viewport with a max-5 queue (oldest dropped first).
 * Toasts auto-dismiss after {@link ToastOptions.durationMs}, pause while
 * hovered, and support an inline action plus manual dismiss.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const nextIdRef = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback((opts: ToastOptions) => {
    const record: ToastRecord = {
      id: ++nextIdRef.current,
      title: opts.title,
      description: opts.description,
      tone: opts.tone ?? 'neutral',
      durationMs: opts.durationMs ?? DEFAULT_DURATION_MS,
      action: opts.action,
    }
    setToasts((prev) => [...prev, record].slice(-MAX_VISIBLE_TOASTS))
  }, [])

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <ToastCard key={t.id} record={t} onDismiss={dismiss} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

function ToastCard({
  record,
  onDismiss,
}: {
  record: ToastRecord
  onDismiss: (id: number) => void
}) {
  const dismiss = useCallback(() => onDismiss(record.id), [onDismiss, record.id])

  // Auto-dismiss timer that pauses while hovered: track remaining time so the
  // deadline survives pause/resume cycles.
  const remainingRef = useRef(record.durationMs)
  const startedAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const armTimer = useCallback(() => {
    startedAtRef.current = Date.now()
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(dismiss, remainingRef.current)
  }, [dismiss])

  const pauseTimer = useCallback(() => {
    clearTimeout(timerRef.current)
    remainingRef.current -= Date.now() - startedAtRef.current
  }, [])

  useEffect(() => {
    armTimer()
    return () => clearTimeout(timerRef.current)
  }, [armTimer])

  const handleAction = useCallback(() => {
    record.action?.onClick()
    dismiss()
  }, [record.action, dismiss])

  return (
    <motion.div
      role="status"
      aria-live="polite"
      onMouseEnter={pauseTimer}
      onMouseLeave={armTimer}
      variants={TOAST_VARIANTS}
      initial="hidden"
      animate="visible"
      exit="exit"
      className={[
        'w-80 rounded-lg border border-border border-l-4 bg-surface-2 p-3 shadow-2',
        TONE_ACCENT_CLASSES[record.tone],
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">{record.title}</p>
          {record.description ? (
            <p className="mt-0.5 text-xs text-fg-muted">{record.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {record.action ? (
            <button
              type="button"
              onClick={handleAction}
              className="rounded-sm px-1 py-0.5 text-xs font-medium text-accent transition-colors hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              {record.action.label}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismiss}
            className="rounded-sm p-1 text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M3 3l6 6M9 3l-6 6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </motion.div>
  )
}
