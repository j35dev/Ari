import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { packagedAsarPath } from './packaged-asar'

describe('packagedAsarPath', () => {
  it('selects the architecture archive in a split universal package', () => {
    const split = join('/resources', 'app-arm64.asar')
    expect(packagedAsarPath('/resources', 'arm64', (path) => path === split)).toBe(split)
  })

  it('uses the standard archive for single-architecture packages', () => {
    expect(packagedAsarPath('/resources', 'x64', () => false)).toBe(join('/resources', 'app.asar'))
  })
})
