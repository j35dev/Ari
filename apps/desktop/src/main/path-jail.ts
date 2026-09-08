import { lstat, realpath } from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Jail for renderer-supplied filesystem paths (P0): every privileged RPC
 * that touches the disk with a renderer-controlled absolute path must
 * resolve it here first. The target is canonicalized through symlinks and
 * required to land inside one of the trusted roots (registered project
 * folders plus managed session worktrees) — the same boundary `fs.writeTextFile`
 * enforces. Reads are jailed exactly like writes; fail-closed throughout.
 */

function isInside(target: string, root: string): boolean {
  const t = process.platform === 'win32' ? target.toLowerCase() : target
  const r = process.platform === 'win32' ? root.toLowerCase() : root
  return t === r || t.startsWith(r + path.sep)
}

/**
 * Canonicalizes `resolved` (an already-absolute path) through symlinks and
 * requires it to land inside one of `roots`. Returns `resolved` unchanged —
 * callers open that path; containment was verified on the canonical form.
 *
 * An existing target resolves via its own realpath. An unresolvable final
 * segment is refused when it exists at all (a dangling symlink's target is
 * unknowable); only a genuinely absent file falls back to its parent
 * directory's realpath. Fail-closed: no resolvable location means no access.
 */
export async function resolveInsideRoots(
  resolved: string,
  roots: readonly string[],
): Promise<string> {
  if (roots.length === 0) throw new Error('no registered project folders')
  let real = await realpath(resolved).catch(() => null)
  if (real === null) {
    // The final segment does not resolve. If it exists at all it is a
    // dangling symlink (or similar) whose true target is unknowable —
    // resolving through it could land anywhere outside the jail.
    if ((await lstat(resolved).catch(() => null)) !== null) {
      throw new Error(`path escapes registered project folders: ${resolved}`)
    }
    real = await realpath(path.dirname(resolved)).catch(() => null)
  }
  if (real === null) throw new Error('parent directory does not exist')
  for (const root of roots) {
    const rootReal = await realpath(root).catch(() => path.resolve(root))
    if (isInside(real, rootReal)) return resolved
  }
  throw new Error(`path escapes registered project folders: ${resolved}`)
}
