import { isEditableTarget } from '../../shell/editable-target'

interface EscapeEvent {
  key: string
  defaultPrevented: boolean
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  nativeEvent: { isComposing?: boolean }
}

/**
 * A bare Esc that nothing else claimed first. Popups, menus, dictation and
 * dialogs that handle Esc prevent its default (or stop it before it gets
 * here), so an Esc they used never also stops the turn.
 */
export function isStopEscape(event: EscapeEvent): boolean {
  return (
    event.key === 'Escape' &&
    !event.defaultPrevented &&
    event.nativeEvent.isComposing !== true &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  )
}

/**
 * Whether an Esc that reached the transcript was pressed on the transcript
 * itself: not in a text field inside it (a diff comment), not in a menu or
 * dialog, and not in a portal whose React tree merely passes through it.
 */
export function transcriptOwnsEscape(container: Element, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !container.contains(target)) return false
  if (isEditableTarget(target)) return false
  const layer = target.closest('[role="dialog"], [role="menu"], [role="listbox"]')
  return layer === null || !container.contains(layer)
}
