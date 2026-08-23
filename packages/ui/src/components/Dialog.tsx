import { createContext, useCallback, useContext, useId, useRef, useState } from 'react'
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
  RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { menuInVariants } from '../motion'
import { useOverlayFocus } from './use-overlay-focus'

/** Scrim must blend over any theme, so it is a raw color-mix rather than a token. */
const SCRIM_STYLE = { background: 'color-mix(in oklab, black 55%, transparent)' } as const

interface DialogContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  panelRef: RefObject<HTMLDivElement | null>
  titleId: string
  descriptionId: string
}

const DialogContext = createContext<DialogContextValue | null>(null)

function useDialogContext(component: string): DialogContextValue {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error(`${component} must be rendered inside <Dialog>`)
  return ctx
}

export interface DialogProps {
  /** Controlled open state; provide together with onOpenChange. */
  open?: boolean
  /** Initial open state for uncontrolled usage. */
  defaultOpen?: boolean
  /** Called with the next state after the dialog opens or closes. */
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}

/** Modal dialog with scrim, focus trap and scale-fade motion; compound API via Dialog.Trigger/Content/Title/Description/Close. */
function DialogRoot({ open, defaultOpen = false, onOpenChange, children }: DialogProps) {
  const [internal, setInternal] = useState(defaultOpen)
  const isControlled = open !== undefined
  const current = isControlled ? open : internal

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternal(next)
      onOpenChange?.(next)
    },
    [isControlled, onOpenChange],
  )

  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  const ctx: DialogContextValue = { open: current, setOpen, panelRef, titleId, descriptionId }

  return <DialogContext.Provider value={ctx}>{children}</DialogContext.Provider>
}

export type DialogTriggerProps = ButtonHTMLAttributes<HTMLButtonElement>

/** Button that opens the dialog. */
export function DialogTrigger({ onClick, type, ...rest }: DialogTriggerProps) {
  const ctx = useDialogContext('Dialog.Trigger')
  return (
    <button
      type={type ?? 'button'}
      aria-haspopup="dialog"
      onClick={(event) => {
        ctx.setOpen(true)
        onClick?.(event)
      }}
      {...rest}
    />
  )
}

export type DialogSize = 'md' | 'lg'

export type DialogContentProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onAnimationIteration'
> & {
  /** `md` is the default confirm panel; `lg` is a workspace overlay (settings). */
  size?: DialogSize
}

const SIZE_CLASS: Record<DialogSize, string> = {
  md: 'w-[min(480px,90vw)] p-5',
  lg: 'flex h-[min(680px,86vh)] w-[min(920px,92vw)] flex-col p-0',
}

/** Centered modal panel portaled to document.body; traps focus while open. */
export function DialogContent({
  className,
  style,
  children,
  size = 'md',
  ...rest
}: DialogContentProps) {
  const { open, setOpen, panelRef, titleId, descriptionId } = useDialogContext('Dialog.Content')
  const close = useCallback(() => setOpen(false), [setOpen])

  useOverlayFocus({ active: open, panelRef, onEscape: close })

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={SCRIM_STYLE}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14, ease: 'easeOut' }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <motion.div
            ref={(node) => {
              panelRef.current = node
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            tabIndex={-1}
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={menuInVariants}
            style={style}
            className={[
              'ari-glass-overlay border border-border rounded-lg shadow-2 outline-none',
              SIZE_CLASS[size],
              className,
            ]
              .filter(Boolean)
              .join(' ')}
            {...rest}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

export type DialogTitleProps = HTMLAttributes<HTMLHeadingElement>

/** Heading whose id is wired to the panel's aria-labelledby. */
export function DialogTitle({ className, ...rest }: DialogTitleProps) {
  const ctx = useDialogContext('Dialog.Title')
  return (
    <h2
      id={ctx.titleId}
      className={['text-base font-semibold text-fg', className].filter(Boolean).join(' ')}
      {...rest}
    />
  )
}

export type DialogDescriptionProps = HTMLAttributes<HTMLParagraphElement>

/** Supporting copy whose id is wired to the panel's aria-describedby. */
export function DialogDescription({ className, ...rest }: DialogDescriptionProps) {
  const ctx = useDialogContext('Dialog.Description')
  return (
    <p
      id={ctx.descriptionId}
      className={['text-sm text-fg-muted', className].filter(Boolean).join(' ')}
      {...rest}
    />
  )
}

export type DialogCloseProps = ButtonHTMLAttributes<HTMLButtonElement>

/** Button that closes the dialog. */
export function DialogClose({ onClick, type, ...rest }: DialogCloseProps) {
  const ctx = useDialogContext('Dialog.Close')
  return (
    <button
      type={type ?? 'button'}
      onClick={(event) => {
        ctx.setOpen(false)
        onClick?.(event)
      }}
      {...rest}
    />
  )
}

export const Dialog = Object.assign(DialogRoot, {
  Trigger: DialogTrigger,
  Content: DialogContent,
  Title: DialogTitle,
  Description: DialogDescription,
  Close: DialogClose,
})
