import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import * as path from 'node:path'

/** Hard ceiling for a single `fs.writeTextFile` payload. */
export const FS_WRITE_MAX_BYTES = 512 * 1024

export interface WriteTextFileParams {
  path: string
  content: string
}

function isInside(target: string, root: string): boolean {
  const t = process.platform === 'win32' ? target.toLowerCase() : target
  const r = process.platform === 'win32' ? root.toLowerCase() : root
  return t === r || t.startsWith(r + path.sep)
}

/**
 * Canonicalizes the write target through symlinks and requires it to land
 * inside one of the registered project folders; anything else is refused.
 *
 * An existing target resolves via its own realpath. An unresolvable final
 * segment is refused when it exists at all (a dangling symlink's target is
 * unknowable); only a genuinely absent file falls back to its parent
 * directory's realpath. Fail-closed: no resolvable location means no write.
 */
async function jailedTarget(resolved: string, roots: readonly string[]): Promise<string> {
  if (roots.length === 0) throw new Error('no registered project folders')
  let real = await realpath(resolved).catch(() => null)
  if (real === null) {
    // The final segment does not resolve. If it exists at all it is a dangling
    // symlink (or similar) whose true target is unknowable — writing through
    // it would land wherever the link points, outside any jail. Fail closed.
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

/**
 * Writes UTF-8 text atomically (sibling temp file + rename) to an absolute
 * path that must stay inside one of the `roots` folders — the same jail the
 * engine tools enforce. Mirrors the read guards: payloads over
 * {@link FS_WRITE_MAX_BYTES} bytes or containing NUL bytes are rejected.
 *
 * Returns the number of UTF-8 bytes written.
 */
export async function writeTextFile(
  params: WriteTextFileParams,
  roots: readonly string[],
): Promise<number> {
  const bytes = Buffer.byteLength(params.content, 'utf8')
  if (bytes > FS_WRITE_MAX_BYTES) {
    throw new Error(`content exceeds the ${FS_WRITE_MAX_BYTES} byte write cap`)
  }
  if (params.content.includes('\0')) throw new Error('binary content cannot be written')

  const target = await jailedTarget(path.resolve(params.path), roots)

  const tmp = `${target}.ari-tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(params.content, 'utf8')
  } finally {
    await handle.close()
  }
  try {
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
  return bytes
}
