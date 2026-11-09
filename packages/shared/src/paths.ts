import { relative, resolve, isAbsolute, sep } from 'node:path'

/** Filesystem identity under the platform's case rules. */
export function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function sameRoot(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

/** Includes the root itself, without matching siblings with the same prefix. */
export function isWithinRoot(path: string, root: string): boolean {
  const child = relative(pathKey(root), pathKey(path))
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}
