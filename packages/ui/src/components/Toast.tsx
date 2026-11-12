import { AnimatePresence, motion } from 'motion/react'
import type { Variants } from 'motion/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { layerRoot } from '../layer-root'
import { transitions } from '@ari/ui/motion'

export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  title: string
  description?: string
  tone?: ToastTone
  /** Auto-dismiss delay. `0` keeps the toast until dismiss or a later update. */
  durationMs?: number
  action?: ToastAction
  /** When false, clicking the action leaves the toast in place so it can be updated. Default true. */
  dismissOnAction?: boolean
}

interface ToastRecord {
  id: number
  title: string
  description?: string
  tone: ToastTone
  durationMs: number
  action?: ToastAction
  dismissOnAction: boolean
  generation: number
}

/**
 * Tone is a small status dot beside the title, never a coloured surface.
 * A neutral toast says nothing about status, so it has no dot.
 */
const TONE_DOT_CLASSES: Record<ToastTone, string | null> = {
  neutral: null,
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
}

const TOAST_VARIANTS: Variants = {
  hidden: { opacity: 0, y: -6 },
  visible: { opacity: 1, y: 0, transition: transitions.fadeUp },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12, ease: 'easeIn' } },
}

const MAX_VISIBLE_TOASTS = 5
const DEFAULT_DURATION_MS = 4000

interface ToastContextValue {
  toast: (opts: ToastOptions) => number
  update: (id: number, opts: Partial<ToastOptions>) => boolean
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

/** Access the toast queue; must be rendered inside {@link ToastProvider}. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

/**
 * Top-right toast viewport (below the titlebar) with a max-5 queue (oldest
 * dropped first). Toasts auto-dismiss after {@link ToastOptions.durationMs}
 * unless that is `0` (sticky), pause while hovered, and support an inline
 * action plus manual dismiss.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const toastsRef = useRef<ToastRecord[]>([])
  const nextIdRef = useRef(0)

  const dismiss = useCallback((id: number) => {
    toastsRef.current = toastsRef.current.filter((t) => t.id !== id)
    setToasts(toastsRef.current)
  }, [])

  const toast = useCallback((opts: ToastOptions): number => {
    const id = ++nextIdRef.current
    const record: ToastRecord = {
      id,
      title: opts.title,
      description: opts.description,
      tone: opts.tone ?? 'neutral',
      durationMs: opts.durationMs ?? DEFAULT_DURATION_MS,
      action: opts.action,
      dismissOnAction: opts.dismissOnAction ?? true,
      generation: 0,
    }
    toastsRef.current = [...toastsRef.current, record].slice(-MAX_VISIBLE_TOASTS)
    setToasts(toastsRef.current)
    return id
  }, [])

  const update = useCallback((id: number, opts: Partial<ToastOptions>): boolean => {
    const current = toastsRef.current
    if (!current.some((record) => record.id === id)) return false
    toastsRef.current = current.map((record) => {
      if (record.id !== id) return record
      return {
        ...record,
        title: opts.title ?? record.title,
        description: 'description' in opts ? opts.description : record.description,
        tone: opts.tone ?? record.tone,
        durationMs: opts.durationMs ?? record.durationMs,
        action: 'action' in opts ? opts.action : record.action,
        dismissOnAction: opts.dismissOnAction ?? record.dismissOnAction,
        generation: record.generation + 1,
      }
    })
    setToasts(toastsRef.current)
    return true
  }, [])

  const value = useMemo(() => ({ toast, update, dismiss }), [toast, update, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          data-toast-viewport
          // Hosts of native views, which paint over the whole document, widen
          // --ari-native-inset-right so the stack stays clear of them.
          className="fixed top-12 right-[calc(var(--ari-native-inset-right,0px)+1rem)] z-toast flex flex-col gap-2"
        >
          <AnimatePresence initial={false}>
            {toasts.map((t) => (
              <ToastCard key={t.id} record={t} onDismiss={dismiss} />
            ))}
          </AnimatePresence>
        </div>,
        layerRoot(),
      )}
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
  const sticky = record.durationMs === 0
  const toneDot = TONE_DOT_CLASSES[record.tone]

  // Auto-dismiss timer that pauses while hovered: track remaining time so the
  // deadline survives pause/resume cycles. `durationMs: 0` is sticky.
  const remainingRef = useRef(record.durationMs)
  const startedAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const armTimer = useCallback(() => {
    if (sticky) return
    startedAtRef.current = Date.now()
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(dismiss, remainingRef.current)
  }, [dismiss, sticky])

  const pauseTimer = useCallback(() => {
    if (sticky) return
    clearTimeout(timerRef.current)
    remainingRef.current -= Date.now() - startedAtRef.current
  }, [sticky])

  useEffect(() => {
    remainingRef.current = record.durationMs
    if (sticky) {
      clearTimeout(timerRef.current)
      return () => clearTimeout(timerRef.current)
    }
    armTimer()
    return () => clearTimeout(timerRef.current)
  }, [armTimer, record.durationMs, record.generation, sticky])

  const handleAction = useCallback(() => {
    record.action?.onClick()
    if (record.dismissOnAction) dismiss()
  }, [record.action, record.dismissOnAction, dismiss])

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
      className="w-80 rounded-xl border border-border-strong bg-surface-1 p-3 shadow-3"
    >
      <div className="flex items-start gap-2.5">
        {toneDot ? (
          <span
            data-toast-tone={record.tone}
            aria-hidden="true"
            // 6px dot centred on the title's 20px first line.
            className={['mt-[7px] size-1.5 shrink-0 rounded-full', toneDot].join(' ')}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-5 font-medium text-fg">{record.title}</p>
          {record.description ? (
            <p className="mt-0.5 text-xs text-fg-muted">{record.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {record.action ? (
            <button
              type="button"
              onClick={handleAction}
              className="rounded-md px-1.5 py-0.5 text-xs font-medium text-fg transition-colors hover:bg-fg/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              {record.action.label}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismiss}
            className="rounded-md p-1 text-fg-subtle transition-colors hover:bg-fg/6 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
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
