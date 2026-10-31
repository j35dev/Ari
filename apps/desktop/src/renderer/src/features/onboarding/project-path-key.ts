/** Matches Windows path spelling without folding case-sensitive POSIX folder names. */
export function projectPathKey(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '') || '/'
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? normalized.toLowerCase() : normalized
}
