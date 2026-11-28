export const LOCAL_FILE_PREFIX = '#ari-file='

export function localPathKind(path: string): 'windows' | 'posix' | 'relative' | null {
  if (!path || path.includes('\0') || path.startsWith('\\') || /^[\\/]{2}/.test(path)) return null
  if (/^[a-z]:[\\/]/i.test(path)) return path.slice(2).includes(':') ? null : 'windows'
  if (path.startsWith('/')) return 'posix'
  return path.includes(':') ? null : 'relative'
}

export function decodeLocalPath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/** A native path as received from Markdown, or a local file URL. */
export function parseLocalFileLink(target: string): string | URL | null {
  if (/^[#?]/.test(target)) return null
  // Keep source-location links and in-page anchors on their existing routes.
  if (/:\d+(?::\d+)?$|#(?:L\d+(?:-L?\d+)?|\d+)$/i.test(target)) return null
  if (/^file:\//i.test(target)) {
    try {
      const url = new URL(target)
      return !url.hostname && localPathKind(decodeLocalPath(url.pathname)) === 'posix' ? url : null
    } catch {
      return null
    }
  }
  // HTML links have historically allowed a literal query or fragment in Markdown.
  const path = decodeLocalPath(target.replace(/(\.html?)[?#].*$/i, '$1'))
  return localPathKind(path) ? path : null
}
