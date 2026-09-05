import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { trayIconPath } from './tray-icon'

describe('trayIconPath', () => {
  it('uses the multi-resolution Windows icon', () => {
    expect(trayIconPath('win32', false, 'app', 'resources')).toBe(join('app', 'build', 'icon.ico'))
    expect(trayIconPath('win32', true, 'app', 'resources')).toBe(join('resources', 'icon.ico'))
  })

  it('uses the portable PNG on macOS and Linux', () => {
    expect(trayIconPath('darwin', false, 'app', 'resources')).toBe(join('app', 'build', 'icon.png'))
    expect(trayIconPath('linux', true, 'app', 'resources')).toBe(join('resources', 'icon.png'))
  })

  it('ships valid source assets for both paths', () => {
    const appPath = join(import.meta.dirname, '../..')
    const pngPath = trayIconPath('linux', false, appPath, 'resources')
    const icoPath = trayIconPath('win32', false, appPath, 'resources')

    expect(existsSync(pngPath)).toBe(true)
    expect(existsSync(icoPath)).toBe(true)
    expect(readFileSync(pngPath).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    expect(readFileSync(icoPath).subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]))
  })
})
