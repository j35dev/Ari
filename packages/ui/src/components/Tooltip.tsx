import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { DetailedReactHTMLElement, HTMLAttributes, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import type { Variants } from 'motion/react'
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react-dom'
import { transitions } from '../motion'

/** 140ms fade in/out (PLAN §6.4 timing budget for transient surfaces). */
const tooltipVariants: Variants = {
  hidden: { opacity: 0, transition: { duration: 0.14, ease: 'easeIn' } },
  visible: { opacity: 1, transition: transitions.menuIn },
}

export interface TooltipProps {
  /** Tooltip body, rendered inside the floating label. */
  content: ReactNode
  /** Side of the anchor to attach to. */
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** Gap between anchor and tooltip in px. */
  sideOffset?: number
  /** Hover delay before showing; keyboard focus shows immediately. */
  delayMs?: number
  /** Single element child that anchors the tooltip and receives the events. */
  children: ReactElement
}

/**
 * Hover/focus tooltip. Shows after `delayMs` of hover or immediately on keyboard
 * focus; hides on unhover, blur, or Escape. The child keeps its own semantics
 * and is linked to the label via aria-describedby.
 */
export function Tooltip({
  content,
  side = 'top',
  sideOffset = 6,
  delayMs = 300,
  children,
}: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)
  const id = useId()

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }, [])

  const showNow = useCallback(() => {
    clearTimer()
    setVisible(true)
  }, [clearTimer])

  const showAfterDelay = useCallback(() => {
    clearTimer()
    timerRef.current = window.setTimeout(() => setVisible(true), delayMs)
  }, [clearTimer, delayMs])

  const hide = useCallback(() => {
    clearTimer()
    setVisible(false)
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [visible, hide])

  const { refs, floatingStyles } = useFloating({
    open: visible,
    placement: side,
    middleware: [offset(sideOffset), flip(), shift()],
    whileElementsMounted: autoUpdate,
    transform: false,
  })

  if (!isValidElement(children)) {
    throw new TypeError('Tooltip requires a single React element as its child')
  }
  const child = children as DetailedReactHTMLElement<HTMLAttributes<HTMLElement>, HTMLElement>
  const previousDescribedBy = child.props['aria-describedby']
  const describedBy = visible
    ? [previousDescribedBy, id].filter(Boolean).join(' ')
    : previousDescribedBy

  return (
    <>
      <span
        ref={refs.setReference}
        className="inline-flex"
        onMouseEnter={showAfterDelay}
        onMouseLeave={hide}
        // React focus/blur bubble, so keyboard focus on the child lands here too.
        onFocus={showNow}
        onBlur={hide}
      >
        {cloneElement(child, { 'aria-describedby': describedBy })}
      </span>
      {createPortal(
        <AnimatePresence>
          {visible && (
            <motion.span
              ref={refs.setFloating}
              role="tooltip"
              id={id}
              initial="hidden"
              animate="visible"
              exit="hidden"
              variants={tooltipVariants}
              style={{ ...floatingStyles }}
              className="pointer-events-none z-50 rounded-md bg-surface-3 px-2 py-1 text-xs text-fg"
            >
              {content}
            </motion.span>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
