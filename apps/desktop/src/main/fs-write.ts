import { open, rename, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { resolveInsideRoots } from './path-jail'

/** Hard ceiling for a single `fs.writeTextFile` payload. */
export const FS_WRITE_MAX_BYTES = 512 * 1024

export interface WriteTextFileParams {
  path: string
  content: string
}

/**
 * Canonicalizes the write target through symlinks and requires it to land
 * inside one of the registered project folders; anything else is refused.
 * See {@link resolveInsideRoots} for the fail-closed resolution rules.
 */
async function jailedTarget(resolved: string, roots: readonly string[]): Promise<string> {
  await resolveInsideRoots(resolved, roots)
  return resolved
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
