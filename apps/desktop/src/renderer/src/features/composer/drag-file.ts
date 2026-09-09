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

/**
 * Absolute OS path for a dropped/pasted file. The sandboxed renderer cannot
 * read paths itself, so the preload bridge resolves them; direct `path`
 * props (unit tests, unsandboxed hosts) are the fallback, then the bare name.
 */
export function osFilePath(file: File): string {
  try {
    const bridged = globalThis.window?.ari?.filePath?.(file)
    if (typeof bridged === 'string' && bridged.length > 0) return bridged
  } catch {
    // Bridge failures fall through to the local fallbacks below.
  }
  const withPath = file as File & { path?: unknown }
  return typeof withPath.path === 'string' && withPath.path.length > 0
    ? withPath.path
    : file.name
}

/**
 * Quote a path for inline prompt text when it contains whitespace or quotes.
 * Embedded quotes are escaped rather than stripped, so the result still names
 * a real file on platforms that allow them — including names that themselves
 * start and end with quotes. Callers always pass raw OS paths, so quoting is
 * unconditional: no pre-quoted detection to misfire.
 */
export function quotePathForPrompt(path: string): string {
  if (path.length === 0) return path
  if (/[\s"]/.test(path)) {
    return `"${path.replaceAll('"', '\\"')}"`
  }
  return path
}
