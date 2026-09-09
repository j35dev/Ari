import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Resolves the active app archive in standard and split universal packages. */
export function packagedAsarPath(
  resourcesPath: string,
  arch: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const splitArchive = join(resourcesPath, `app-${arch}.asar`)
  return exists(splitArchive) ? splitArchive : join(resourcesPath, 'app.asar')
}
