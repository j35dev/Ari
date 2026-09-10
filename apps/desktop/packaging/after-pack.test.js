// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { expectedPtyPackages } from './after-pack.js'

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
