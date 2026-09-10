// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTray } from './tray'

const mocks = vi.hoisted(() => {
  const resized = { name: 'menu-bar-sized image' }
  const icon = { isEmpty: vi.fn(() => false), resize: vi.fn(() => resized) }
  return {
    resized,
    icon,
    Tray: vi.fn(
      class {
        setToolTip = vi.fn()
        setContextMenu = vi.fn()
        on = vi.fn()
        destroy = vi.fn()
      },
    ),
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => '/app', quit: vi.fn() },
  nativeImage: { createFromPath: () => mocks.icon },
  Tray: mocks.Tray,
  Menu: { buildFromTemplate: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('tray image construction', () => {
  it('passes a menu-bar-sized image to the macOS tray, not the full app icon', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', resourcesPath: '/resources' })
    createTray(vi.fn())
    expect(mocks.icon.resize).toHaveBeenCalledWith({ width: 18, height: 18 })
    expect(mocks.Tray).toHaveBeenCalledWith(mocks.resized)
  })

  it.each(['win32', 'linux'])('preserves the existing %s image', (platform) => {
    vi.stubGlobal('process', { ...process, platform, resourcesPath: '/resources' })
    createTray(vi.fn())
    expect(mocks.icon.resize).not.toHaveBeenCalled()
    expect(mocks.Tray).toHaveBeenCalledWith(mocks.icon)
  })

  it('rejects a missing icon before constructing a tray', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', resourcesPath: '/resources' })
    mocks.icon.isEmpty.mockReturnValueOnce(true)
    expect(() => createTray(vi.fn())).toThrow('tray icon could not be loaded')
    expect(mocks.Tray).not.toHaveBeenCalled()
  })
})
