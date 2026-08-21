import { createContext, useCallback, useContext, useId, useRef, useState } from 'react'
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
  RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import type { Variants } from 'motion/react'
import { transitions } from '../motion'
import { useOverlayFocus } from './use-overlay-focus'

/** Scrim must blend over any theme, so it is a raw color-mix rather than a token. */
const SCRIM_STYLE = { background: 'color-mix(in oklab, black 55%, transparent)' } as const

export type SheetSide = 'right' | 'left' | 'bottom'

const PANEL_CLASS: Record<SheetSide, string> = {
  right: 'fixed top-0 right-0 h-full w-[min(420px,85vw)] rounded-l-lg',
  left: 'fixed top-0 left-0 h-full w-[min(420px,85vw)] rounded-r-lg',
  bottom: 'fixed bottom-0 left-0 w-full h-[min(420px,85vh)] rounded-t-lg',
}

const slideVariants: Record<SheetSide, Variants> = {
  right: {
    hidden: { x: '100%' },
    visible: { x: 0, transition: transitions.paneSlide },
    exit: { x: '100%', transition: transitions.paneSlide },
  },
  left: {
    hidden: { x: '-100%' },
    visible: { x: 0, transition: transitions.paneSlide },
    exit: { x: '-100%', transition: transitions.paneSlide },
  },
  bottom: {
    hidden: { y: '100%' },
    visible: { y: 0, transition: transitions.paneSlide },
    exit: { y: '100%', transition: transitions.paneSlide },
  },
}

interface SheetContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  panelRef: RefObject<HTMLDivElement | null>
  titleId: string
  descriptionId: string
}

const SheetContext = createContext<SheetContextValue | null>(null)

function useSheetContext(component: string): SheetContextValue {
  const ctx = useContext(SheetContext)
  if (!ctx) throw new Error(`${component} must be rendered inside <Sheet>`)
  return ctx
}

export interface SheetProps {
  /** Controlled open state; provide together with onOpenChange. */
  open?: boolean
  /** Initial open state for uncontrolled usage. */
  defaultOpen?: boolean
  /** Called with the next state after the sheet opens or closes. */
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}

/** Edge-anchored overlay with focus trap and slide motion; compound API via Sheet.Trigger/Content/Title/Description/Close. */
function SheetRoot({ open, defaultOpen = false, onOpenChange, children }: SheetProps) {
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

  const ctx: SheetContextValue = { open: current, setOpen, panelRef, titleId, descriptionId }

  return <SheetContext.Provider value={ctx}>{children}</SheetContext.Provider>
}

export type SheetTriggerProps = ButtonHTMLAttributes<HTMLButtonElement>

/** Button that opens the sheet. */
export function SheetTrigger({ onClick, type, ...rest }: SheetTriggerProps) {
  const ctx = useSheetContext('Sheet.Trigger')
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

export interface SheetContentProps
  extends Omit<
    HTMLAttributes<HTMLDivElement>,
    | 'onDrag'
    | 'onDragStart'
    | 'onDragEnd'
    | 'onAnimationStart'
    | 'onAnimationEnd'
    | 'onAnimationIteration'
  > {
  /** Which edge the sheet slides in from. */
  side?: SheetSide
}

/** Edge-sliding panel portaled to document.body; traps focus while open. */
export function SheetContent({
  side = 'right',
  className,
  style,
  children,
  ...rest
}: SheetContentProps) {
  const { open, setOpen, panelRef, titleId, descriptionId } = useSheetContext('Sheet.Content')
  const close = useCallback(() => setOpen(false), [setOpen])

  useOverlayFocus({ active: open, panelRef, onEscape: close })

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="sheet-scrim"
          className="fixed inset-0 z-50"
          style={SCRIM_STYLE}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14, ease: 'easeOut' }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        />
      )}
      {open && (
        <motion.div
          key="sheet-panel"
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
          variants={slideVariants[side]}
          style={style}
          className={[
            PANEL_CLASS[side],
            'bg-surface-1 border border-border shadow-2 p-5 outline-none',
            className,
          ]
            .filter(Boolean)
            .join(' ')}
          {...rest}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

export type SheetTitleProps = HTMLAttributes<HTMLHeadingElement>

/** Heading whose id is wired to the panel's aria-labelledby. */
export function SheetTitle({ className, ...rest }: SheetTitleProps) {
  const ctx = useSheetContext('Sheet.Title')
  return (
    <h2
      id={ctx.titleId}
      className={['text-base font-semibold text-fg', className].filter(Boolean).join(' ')}
      {...rest}
    />
  )
}

export type SheetDescriptionProps = HTMLAttributes<HTMLParagraphElement>

/** Supporting copy whose id is wired to the panel's aria-describedby. */
export function SheetDescription({ className, ...rest }: SheetDescriptionProps) {
  const ctx = useSheetContext('Sheet.Description')
  return (
    <p
      id={ctx.descriptionId}
      className={['text-sm text-fg-muted', className].filter(Boolean).join(' ')}
      {...rest}
    />
  )
}

export type SheetCloseProps = ButtonHTMLAttributes<HTMLButtonElement>

/** Button that closes the sheet. */
export function SheetClose({ onClick, type, ...rest }: SheetCloseProps) {
  const ctx = useSheetContext('Sheet.Close')
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

export const Sheet = Object.assign(SheetRoot, {
  Trigger: SheetTrigger,
  Content: SheetContent,
  Title: SheetTitle,
  Description: SheetDescription,
  Close: SheetClose,
})
