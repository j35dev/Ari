import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Turns what an agent wrote for an HTML file (a path, a `file:` URL, or a
 * markdown link target, which arrives percent-encoded) into an absolute path.
 * Only `.html` and `.htm` qualify: this is the one kind of local file a click
 * in the chat may hand to the system, so a link can never launch a program.
 * Throws with a sentence the user can read.
 */
export function resolveLocalHtml(input: string, baseDir: string | null): string {
  let path = input.trim()
  if (/^file:/i.test(path)) {
    try {
      path = fileURLToPath(path)
    } catch {
      throw new Error('That file link is not a valid path.')
    }
  } else {
    // A page link may carry `#section` or `?query`; neither is part of the file.
    path = path.replace(/[#?].*$/, '')
    try {
      path = decodeURIComponent(path)
    } catch {
      // A stray `%` is part of the name.
    }
  }
  if (!/\.html?$/i.test(path)) throw new Error('Only HTML files open from the chat.')
  // `\\host\share`, `\\?\UNC\…` and `file://host/…` (which reads as the
  // former) reach out to another machine, and Windows answers its login
  // challenge with the user's NTLM hash. Only files on this computer open.
  if (/^[\\/]{2}/.test(path)) throw new Error('Only files on this computer open from the chat.')
  if (isAbsolute(path)) return resolve(path)
  if (baseDir === null) throw new Error(`Can't tell which folder ${path} is in.`)
  return resolve(baseDir, path)
}
