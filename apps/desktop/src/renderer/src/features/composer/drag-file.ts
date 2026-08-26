import type { DragEvent } from 'react'

/**
 * Payload type marking an in-app file-reference drag: a pane row (file
 * explorer, changes list) dragged toward the composer. OS file drags carry
 * `Files` instead, so the two never collide.
 */
export const FILE_MIME = 'application/x-ari-file-path'

/** Stamps a drag event with the workspace-relative path being dragged. */
export function setDragFilePath(event: DragEvent<HTMLElement>, path: string): void {
  event.dataTransfer.setData(FILE_MIME, path)
  event.dataTransfer.effectAllowed = 'copy'
}

/** Reads the dragged file path; null when the drag did not originate in-app. */
export function readDragFilePath(event: DragEvent<HTMLElement>): string | null {
  const path = event.dataTransfer.getData(FILE_MIME)
  return path.length > 0 ? path : null
}
