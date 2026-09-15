import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface MobileWebRootEnvironment {
  isPackaged: boolean
  /** `process.resourcesPath` — where packaged extras live. */
  resourcesPath: string
  /** `app.getAppPath()` — the desktop app directory in development. */
  appPath: string
}

/**
 * The built PWA the gateway serves under Tailscale, or undefined when it has
 * not been built. Undefined is the honest answer: the gateway then serves the
 * API alone, rather than a shell that is not there.
 */
export function mobileWebRoot(
  env: MobileWebRootEnvironment,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const candidate = env.isPackaged
    ? join(env.resourcesPath, 'mobile')
    : // An electron-vite dev build runs from apps/desktop, so the PWA is the
      // sibling package's build output.
      join(env.appPath, '..', '..', 'apps', 'mobile', 'dist')
  return exists(candidate) ? candidate : undefined
}
