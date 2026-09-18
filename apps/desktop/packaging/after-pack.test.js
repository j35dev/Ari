// @vitest-environment node
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectedPtyPackages, mobileShellPath } from './after-pack.js'

describe('pty packaging guard', () => {
  it('requires the resolver stub plus the target platform package', () => {
    expect(expectedPtyPackages('win32', 1)).toEqual(['@lydell/node-pty-win32-x64'])
    expect(expectedPtyPackages('linux', 3)).toEqual(['@lydell/node-pty-linux-arm64'])
  })

  it('includes both native slices for universal macOS', () => {
    expect(expectedPtyPackages('darwin', 4)).toEqual([
      '@lydell/node-pty-darwin-x64',
      '@lydell/node-pty-darwin-arm64',
    ])
  })
})

describe('mobile PWA packaging guard', () => {
  it('points at the PWA shell inside packaged resources', () => {
    expect(mobileShellPath('/opt/ari/resources')).toBe(
      join('/opt/ari/resources', 'mobile', 'index.html'),
    )
  })
})
