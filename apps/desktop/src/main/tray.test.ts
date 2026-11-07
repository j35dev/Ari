// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTray } from './tray'
import { app, Menu } from 'electron'

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
        isDestroyed = vi.fn(() => false)
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

  it('keeps the background label when counts update, and keeps Show and explicit Quit actionable', () => {
    vi.stubGlobal('process', { ...process, resourcesPath: '/resources' })
    const show = vi.fn()
    const handle = createTray(show)
    handle.setBackgrounded(true)
    handle.setStatus(2)
    const tray = mocks.Tray.mock.results[0]!.value as {
      setToolTip: ReturnType<typeof vi.fn>
      isDestroyed: ReturnType<typeof vi.fn>
    }
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Ari — in background · 2 running')
    const menu = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1)![0]
    expect(menu).toContainEqual({
      label: 'Show Ari to return; Quit stops background work',
      enabled: false,
    })
    const showItem = menu.find((item) => item.label === 'Show Ari')!
    const quitItem = menu.find((item) => item.label === 'Quit')!
    // Electron's menu callbacks accept arguments; these closures use none.
    Reflect.apply(showItem.click!, undefined, [])
    Reflect.apply(quitItem.click!, undefined, [])
    expect(show).toHaveBeenCalledOnce()
    expect(app.quit).toHaveBeenCalledOnce()
    handle.setBackgrounded(false)
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Ari — 2 running')
    tray.isDestroyed.mockReturnValue(true)
    expect(handle.isDestroyed()).toBe(true)
  })

  it('destroys a partially initialized tray when menu setup fails', () => {
    vi.stubGlobal('process', { ...process, resourcesPath: '/resources' })
    vi.mocked(Menu.buildFromTemplate).mockImplementationOnce(() => {
      throw new Error('no menus')
    })
    expect(() => createTray(vi.fn())).toThrow('no menus')
    expect(mocks.Tray.mock.results[0]!.value.destroy).toHaveBeenCalledOnce()
  })
})
