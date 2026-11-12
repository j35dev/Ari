import { isAbsolute, join } from 'node:path'

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

interface DevEnvironment {
  ARI_DEV_INSTANCE?: string
  ARI_DEV_USER_DATA?: string
}

function devIdentity(environment: DevEnvironment) {
  const instance = environment.ARI_DEV_INSTANCE
  if (!instance) return { name: DEV_APP_NAME, modelId: DEV_APP_USER_MODEL_ID }
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(instance)) throw new Error('Invalid dev instance name')
  const profile = environment.ARI_DEV_USER_DATA
  if (!profile || !isAbsolute(profile)) throw new Error('Named dev instances need an absolute profile')
  return {
    name: `${DEV_APP_NAME} ${instance[0]!.toUpperCase()}${instance.slice(1)}`,
    modelId: `${DEV_APP_USER_MODEL_ID}.${instance}`,
    profile,
  }
}

export function appDisplayName(isPackaged: boolean, environment: DevEnvironment = process.env): string {
  return isPackaged ? PACKAGED_APP_NAME : devIdentity(environment).name
}

/**
 * Give unpackaged runs a distinct Electron identity: name, userData, and
 * Windows AppUserModelID. Must run before `requestSingleInstanceLock()` —
 * the lock (and every store under userData) is keyed off that identity.
 *
 * Packaged installs are left untouched so they keep `%APPDATA%/Ari`.
 * Returns whether the process was rewritten onto the dev identity.
 */
export function isolateDevInstance(app: AppIdentity, environment: DevEnvironment = process.env): boolean {
  if (app.isPackaged) return false
  const identity = devIdentity(environment)
  app.setName(identity.name)
  app.setPath('userData', identity.profile ?? join(app.getPath('appData'), identity.name))
  app.setAppUserModelId(identity.modelId)
  return true
}
