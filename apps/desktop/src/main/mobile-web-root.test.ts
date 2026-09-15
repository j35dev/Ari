import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mobileWebRoot } from './mobile-web-root'

describe('mobileWebRoot', () => {
  it('finds the sibling package build in development', () => {
    const appPath = resolve('/repo/apps/desktop')
    const found = mobileWebRoot(
      { isPackaged: false, resourcesPath: '/unused', appPath },
      (path) => path === resolve('/repo/apps/mobile/dist'),
    )

    expect(found).toBe(resolve('/repo/apps/mobile/dist'))
  })

  it('finds the packaged copy beside the app resources', () => {
    const found = mobileWebRoot(
      { isPackaged: true, resourcesPath: resolve('/opt/ari/resources'), appPath: '/unused' },
      (path) => path === join(resolve('/opt/ari/resources'), 'mobile'),
    )

    expect(found).toBe(join(resolve('/opt/ari/resources'), 'mobile'))
  })

  it('answers undefined when the PWA has not been built', () => {
    const found = mobileWebRoot(
      { isPackaged: false, resourcesPath: '/unused', appPath: resolve('/repo/apps/desktop') },
      () => false,
    )

    // No shell means the gateway serves the API alone; a directory that is not
    // there must not be handed to it as if it were.
    expect(found).toBeUndefined()
  })
})
