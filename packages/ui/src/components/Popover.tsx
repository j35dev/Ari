import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react-dom'
import type { Placement } from '@floating-ui/react-dom'
import { menuInVariants } from '../motion'
import { layerRoot } from '../layer-root'
import { useOverlayRef } from '../overlay-registry'

type Side = 'top' | 'bottom' | 'left' | 'right'

const PANEL_CHROME = 'bg-surface-2 border border-border rounded-lg shadow-2 p-3'
type Align = 'start' | 'center' | 'end'

interface PopoverContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  anchor: HTMLElement | null
  setAnchor: (el: HTMLElement | null) => void
  triggerRef: RefObject<HTMLButtonElement | null>
  contentRef: RefObject<HTMLDivElement | null>
}

const PopoverContext = createContext<PopoverContextValue | null>(null)

function usePopoverContext(component: string): PopoverContextValue {
  const ctx = useContext(PopoverContext)
  if (!ctx) throw new Error(`${component} must be rendered inside <Popover>`)
  return ctx
}

/** placement "bottom-start" grows from its top-left corner; center sides from their edge midpoint. */
function transformOriginFor(placement: Placement): string {
  const [side, align] = placement.split('-')
  const cross = align ?? 'center'
  if (side === 'top') return `${cross} bottom`
  if (side === 'bottom') return `${cross} top`
  if (side === 'left') return `right ${cross}`
  return `left ${cross}`
}

export interface PopoverProps {
  /** Controlled open state; provide together with onOpenChange. */
  open?: boolean
  /** Initial open state for uncontrolled usage. */
  defaultOpen?: boolean
  /** Called with the next state after the popover opens or closes. */
  onOpenChange?: (open: boolean) => void
  /**
   * Positions the panel against this element instead of a Popover.Trigger,
   * for menus with a trigger of their own. Presses inside it are not outside
   * presses, so that trigger keeps toggling the menu itself.
   */
  anchor?: HTMLElement | null
  children: ReactNode
}

/**
 * Eats the click that completes an outside press, so dismissing a popover
 * does not also press whatever sat under the pointer. Another menu's trigger
 * is let through, so moving from one menu to the next is still one click.
 */
function swallowClickAfter(target: Element | null): void {
  if (target?.closest('[aria-haspopup]')) return
  const eat = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }
  window.addEventListener('click', eat, { capture: true, once: true })
  // A drag, or a press released elsewhere, ends without a click.
  const release = (): void => {
    window.setTimeout(() => window.removeEventListener('click', eat, true), 0)
  }
  window.addEventListener('pointerup', release, { capture: true, once: true })
}

/** Non-modal floating panel anchored to its trigger; compound API via Popover.Trigger/Content. */
function PopoverRoot({
  open,
  defaultOpen = false,
  onOpenChange,
  anchor: anchorProp,
  children,
}: PopoverProps) {
  const [internal, setInternal] = useState(defaultOpen)
  const isControlled = open !== undefined
  const current = isControlled ? open : internal

  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternal(next)
      onOpenChange?.(next)
    },
    [isControlled, onOpenChange],
  )

  useEffect(() => {
    if (!current) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (contentRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      if (anchorProp?.contains(target)) return
      setOpen(false)
      swallowClickAfter(event.target instanceof Element ? event.target : null)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [current, setOpen, anchorProp])

  // Return focus to the trigger whenever an open popover closes.
  const wasOpen = useRef(current)
  useEffect(() => {
    if (wasOpen.current && !current) triggerRef.current?.focus()
    wasOpen.current = current
  }, [current])

  const ctx: PopoverContextValue = {
    open: current,
    setOpen,
    anchor: anchorProp ?? anchor,
    setAnchor,
    triggerRef,
    contentRef,
  }

  return <PopoverContext.Provider value={ctx}>{children}</PopoverContext.Provider>
}

export type PopoverTriggerProps = ButtonHTMLAttributes<HTMLButtonElement>

/** Button that toggles the popover; registers itself as the floating anchor. */
export function PopoverTrigger({ className, onClick, type, ...rest }: PopoverTriggerProps) {
  const ctx = usePopoverContext('Popover.Trigger')
  return (
    <button
      type={type ?? 'button'}
      ref={(node) => {
        ctx.triggerRef.current = node
        ctx.setAnchor(node)
      }}
      aria-haspopup="dialog"
      aria-expanded={ctx.open}
      onClick={(event) => {
        ctx.setOpen(!ctx.open)
        onClick?.(event)
      }}
      className={className}
      {...rest}
    />
  )
}

export interface PopoverContentProps
  extends Omit<
    HTMLAttributes<HTMLDivElement>,
    | 'onDrag'
    | 'onDragStart'
    | 'onDragEnd'
    | 'onAnimationStart'
    | 'onAnimationEnd'
    | 'onAnimationIteration'
  > {
  /** Which side of the trigger to attach to. */
  side?: Side
  /** Alignment along that side. */
  align?: Align
  /** Gap between trigger and panel in px. */
  sideOffset?: number
  /** Drops the default panel chrome (fill, border, padding) for menus that bring their own. */
  bare?: boolean
}

/** Floating panel portaled to the layer root; animates in with the menu-in motion. */
export function PopoverContent({
  side = 'bottom',
  align = 'center',
  sideOffset = 8,
  bare = false,
  className,
  style,
  children,
  ...rest
}: PopoverContentProps) {
  const ctx = usePopoverContext('Popover.Content')
  const overlayRef = useOverlayRef()
  const placement: Placement = align === 'center' ? side : `${side}-${align}`

  const { refs, floatingStyles } = useFloating({
    open: ctx.open,
    placement,
    middleware: [offset(sideOffset), flip(), shift()],
    whileElementsMounted: autoUpdate,
    elements: { reference: ctx.anchor },
    // left/top positioning only, so motion owns `transform` for the scale-in.
    transform: false,
  })

  return createPortal(
    <AnimatePresence>
      {ctx.open && (
        <motion.div
          ref={(node) => {
            refs.setFloating(node)
            ctx.contentRef.current = node
            overlayRef(node)
          }}
          role="dialog"
          initial="hidden"
          animate="visible"
          exit="exit"
          variants={menuInVariants}
          style={{ ...floatingStyles, transformOrigin: transformOriginFor(placement), ...style }}
          className={['z-popover', bare ? null : PANEL_CHROME, className]
            .filter(Boolean)
            .join(' ')}
          {...rest}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    layerRoot(),
  )
}

export const Popover = Object.assign(PopoverRoot, {
  Trigger: PopoverTrigger,
  Content: PopoverContent,
})
