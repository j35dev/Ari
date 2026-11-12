import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEV_APP_NAME,
  DEV_APP_USER_MODEL_ID,
  PACKAGED_APP_NAME,
  PACKAGED_APP_USER_MODEL_ID,
  appDisplayName,
  isolateDevInstance,
  type AppIdentity,
} from './dev-instance'

function fakeApp(isPackaged: boolean, appData = '/tmp/appdata'): AppIdentity & {
  names: string[]
  paths: Array<readonly [string, string]>
  modelIds: string[]
} {
  const names: string[] = []
  const paths: Array<readonly [string, string]> = []
  const modelIds: string[] = []
  return {
    isPackaged,
    names,
    paths,
    modelIds,
    setName: (name) => {
      names.push(name)
    },
    setPath: (name, path) => {
      paths.push([name, path])
    },
    setAppUserModelId: (id) => {
      modelIds.push(id)
    },
    getPath: () => appData,
  }
}

describe('appDisplayName', () => {
  it('keeps the packaged product name', () => {
    expect(appDisplayName(true)).toBe(PACKAGED_APP_NAME)
  })

  it('labels unpackaged runs as Ari Dev', () => {
    expect(appDisplayName(false)).toBe(DEV_APP_NAME)
  })
})

describe('isolateDevInstance', () => {
  it('isolates a named unpackaged run without changing the default identity', () => {
    const app = fakeApp(false)
    const environment = { ARI_DEV_INSTANCE: 'machines', ARI_DEV_USER_DATA: '/tmp/machines-profile' }
    expect(isolateDevInstance(app, environment)).toBe(true)
    expect(app.names).toEqual(['Ari Dev Machines'])
    expect(app.paths).toEqual([['userData', environment.ARI_DEV_USER_DATA]])
    expect(app.modelIds).toEqual([`${DEV_APP_USER_MODEL_ID}.machines`])
    expect(appDisplayName(false, environment)).toBe('Ari Dev Machines')
    expect(appDisplayName(false, {})).toBe(DEV_APP_NAME)
  })

  it('rejects incomplete overrides before changing any identity fields', () => {
    const app = fakeApp(false)
    expect(() => isolateDevInstance(app, { ARI_DEV_INSTANCE: 'machines' })).toThrow('absolute profile')
    expect(app.names).toEqual([])
    expect(app.paths).toEqual([])
  })

  it('ignores overrides for packaged installs', () => {
    const app = fakeApp(true)
    expect(isolateDevInstance(app, { ARI_DEV_INSTANCE: 'invalid name' })).toBe(false)
    expect(app.names).toEqual([])
    expect(appDisplayName(true, { ARI_DEV_INSTANCE: 'invalid name' })).toBe(PACKAGED_APP_NAME)
  })

  it('rewrites name, userData, and AppUserModelID when unpackaged', () => {
    const app = fakeApp(false, '/Users/dev/Library/Application Support')
    expect(isolateDevInstance(app)).toBe(true)
    expect(app.names).toEqual([DEV_APP_NAME])
    expect(app.paths).toEqual([
      ['userData', join('/Users/dev/Library/Application Support', DEV_APP_NAME)],
    ])
    expect(app.modelIds).toEqual([DEV_APP_USER_MODEL_ID])
    expect(DEV_APP_USER_MODEL_ID).not.toBe(PACKAGED_APP_USER_MODEL_ID)
  })

  it('leaves a packaged app untouched so it keeps the installed profile', () => {
    const app = fakeApp(true)
    expect(isolateDevInstance(app)).toBe(false)
    expect(app.names).toEqual([])
    expect(app.paths).toEqual([])
    expect(app.modelIds).toEqual([])
  })
})
