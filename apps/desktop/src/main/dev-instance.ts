import { join } from 'node:path'

/** Packaged product name (electron-builder `productName`). */
export const PACKAGED_APP_NAME = 'Ari'

/** Unpackaged `pnpm dev` identity so it can coexist with an installed Ari. */
export const DEV_APP_NAME = 'Ari Dev'

/** Matches electron-builder `appId`; Windows taskbar grouping key. */
export const PACKAGED_APP_USER_MODEL_ID = 'com.ari.desktop'
export const DEV_APP_USER_MODEL_ID = 'com.ari.desktop.dev'

/** Narrow Electron `app` surface used at boot, before the single-instance lock. */
export interface AppIdentity {
  readonly isPackaged: boolean
  setName(name: string): void
  setPath(name: 'userData', path: string): void
  setAppUserModelId(id: string): void
  getPath(name: 'appData'): string
}

export function appDisplayName(isPackaged: boolean): string {
  return isPackaged ? PACKAGED_APP_NAME : DEV_APP_NAME
}

/**
 * Give unpackaged runs a distinct Electron identity: name, userData, and
 * Windows AppUserModelID. Must run before `requestSingleInstanceLock()` —
 * the lock (and every store under userData) is keyed off that identity.
 *
 * Packaged installs are left untouched so they keep `%APPDATA%/Ari`.
 * Returns whether the process was rewritten onto the dev identity.
 */
export function isolateDevInstance(app: AppIdentity): boolean {
  if (app.isPackaged) return false
  app.setName(DEV_APP_NAME)
  app.setPath('userData', join(app.getPath('appData'), DEV_APP_NAME))
  app.setAppUserModelId(DEV_APP_USER_MODEL_ID)
  return true
}
