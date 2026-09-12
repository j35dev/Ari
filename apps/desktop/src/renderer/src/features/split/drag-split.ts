import type { DragEvent } from 'react'

/**
 * Payload types for the two drags that end on a pane. A sidebar row carries a
 * session to open; a pane header carries a pane to trade places with. They are
 * separate types rather than one payload because the drop means different
 * things, and because they tell the drop zones which overlay to draw.
 */
export const SESSION_MIME = 'application/x-ari-session-id'
export const PANE_MIME = 'application/x-ari-pane-id'

/**
 * Whether a drag carries `mime`. Only the type list is readable while a drag is
 * over a target — the payload itself is off limits until the drop — so this is
 * what `dragover` has to ask.
 */
export function hasDragType(event: DragEvent<HTMLElement>, mime: string): boolean {
  return event.dataTransfer.types.includes(mime)
}

export function setDragSession(
  event: DragEvent<HTMLElement>,
  sessionId: string,
  title: string,
): void {
  event.dataTransfer.setData(SESSION_MIME, sessionId)
  event.dataTransfer.effectAllowed = 'move'
  setDragChip(event, title)
}

export function readDragSession(event: DragEvent<HTMLElement>): string | null {
  const sessionId = event.dataTransfer.getData(SESSION_MIME)
  return sessionId.length > 0 ? sessionId : null
}

export function setDragPane(event: DragEvent<HTMLElement>, paneId: string, title: string): void {
  event.dataTransfer.setData(PANE_MIME, paneId)
  event.dataTransfer.effectAllowed = 'move'
  setDragChip(event, title)
}

export function readDragPane(event: DragEvent<HTMLElement>): string | null {
  const paneId = event.dataTransfer.getData(PANE_MIME)
  return paneId.length > 0 ? paneId : null
}

/**
 * The small rounded chip that follows the pointer: the dragged session's name
 * instead of the browser's snapshot of a whole sidebar row or pane.
 *
 * Styled inline rather than with utilities because the browser paints this node
 * the moment it is handed over — it never goes through a render — so it cannot
 * depend on anything but the classes and custom properties already on the page.
 */
function setDragChip(event: DragEvent<HTMLElement>, title: string): void {
  const chip = document.createElement('div')
  chip.textContent = title
  chip.className = 'ari-glass-overlay'
  Object.assign(chip.style, {
    position: 'fixed',
    top: '-1000px',
    left: '-1000px',
    padding: '3px 8px',
    border: '1px solid var(--ari-border)',
    borderRadius: 'var(--ari-radius-sm)',
    boxShadow: 'var(--ari-shadow-2)',
    color: 'var(--ari-fg)',
    fontSize: 'var(--ari-text-xs)',
    fontFamily: 'var(--ari-font-ui)',
    maxWidth: '180px',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  })
  document.body.append(chip)
  event.dataTransfer.setDragImage(chip, 12, 12)
  // The snapshot is taken synchronously; the node has done its job by now.
  setTimeout(() => chip.remove(), 0)
}
