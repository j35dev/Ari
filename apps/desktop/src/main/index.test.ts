// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type * as WindowModule from './window'
import { RpcRegistry } from './rpc-registry'
import { registerWindowControls } from './window'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => this.destroyed,
      reload: vi.fn(),
    })
    destroyed = false
    minimized = false
    visible = false
    // Renderer state belongs to this window, not to the app fixture.
    draft = 'unfinished prompt'
    isDestroyed = () => this.destroyed
    isMinimized = () => this.minimized
    isVisible = () => this.visible
    restore = vi.fn(() => {
      this.minimized = false
    })
    show = vi.fn(() => {
      this.visible = true
      this.emit('show')
    })
    hide = vi.fn(() => {
      this.visible = false
      this.emit('hide')
    })
    focus = vi.fn()
    close = vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      this.emit('close', event)
      if (event.preventDefault.mock.calls.length > 0) return
      this.destroyed = true
      this.webContents.emit('destroyed')
      this.emit('closed')
      app.emit('window-all-closed')
    })
  }
  const windows: Window[] = []
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    commandLine: { appendSwitch: vi.fn() },
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
    exit: vi.fn(),
  })
  app.quit.mockImplementation(() => {
    const event = { preventDefault: vi.fn() }
    app.emit('before-quit', event)
    if (event.preventDefault.mock.calls.length > 0) return
    for (const window of windows) if (!window.destroyed) window.close()
    app.emit('will-quit')
  })
  const tray = {
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
    setStatus: vi.fn(),
    setBackgrounded: vi.fn(),
  }
  const createWindow = vi.fn(() => {
    const window = new Window()
    windows.push(window)
    return window
  })
  const createTray = vi.fn((_show: () => void) => tray)
  const shutdown = vi.fn(async () => undefined)
  const registerRpc = vi.fn((_contents: unknown, _options: unknown) => ({ shutdown }))
  const powerMonitor = new EventEmitter()
  const firstPaint = vi.fn(
    (window: Window) =>
      new Promise<void>((resolve) => {
        window.once('ready-to-show', resolve)
      }),
  )
  return {
    app,
    windows,
    tray,
    createWindow,
    createTray,
    registerRpc,
    shutdown,
    powerMonitor,
    firstPaint,
    startUpdates: vi.fn(),
    presenceStop: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: fixture.app,
  powerMonitor: fixture.powerMonitor,
  BrowserWindow: {
    fromWebContents: (contents: unknown) =>
      fixture.windows.find((window) => window.webContents === contents),
    getAllWindows: () => fixture.windows.filter((window) => !window.destroyed),
  },
}))
vi.mock('./dev-instance', () => ({ isolateDevInstance: vi.fn() }))
vi.mock('./discord-presence', () => ({
  DiscordPresence: class {
    setRunningCount = vi.fn()
    setEnabled = vi.fn()
    stop = fixture.presenceStop
  },
}))
vi.mock('./rpc', () => ({
  registerRpc: fixture.registerRpc,
  startAppUpdateChecks: fixture.startUpdates,
}))
vi.mock('./startup-gate', () => ({ afterFirstPaint: fixture.firstPaint }))
vi.mock('./store', () => ({
  getSettingsStore: () => ({
    load: async () => undefined,
    current: { notifications: { discordPresence: false } },
  }),
}))
vi.mock('./tray', () => ({ createTray: fixture.createTray }))
vi.mock('./window', async (importOriginal) => ({
  ...(await importOriginal<typeof WindowModule>()),
  createMainWindow: fixture.createWindow,
}))

let registry: RpcRegistry
let delivered: unknown[]

async function boot(platform = 'win32') {
  vi.stubGlobal('process', { ...process, platform })
  await import('./index')
  await Promise.resolve()
  return fixture.windows[0]!
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fixture.app.removeAllListeners()
  fixture.powerMonitor.removeAllListeners()
  fixture.windows.length = 0
  fixture.createTray.mockImplementation(() => fixture.tray)
  fixture.tray.isDestroyed.mockReturnValue(false)
  fixture.tray.setBackgrounded.mockImplementation(() => undefined)
  delivered = []
  fixture.registerRpc.mockImplementation((contents) => {
    registry = new RpcRegistry({ send: (frame) => delivered.push(frame) })
    registerWindowControls(contents as WebContents, registry)
    return { shutdown: fixture.shutdown }
  })
  fixture.shutdown.mockResolvedValue(undefined)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('main window lifetime', () => {
  it('routes renderer Close through the native close policy and preserves live subscriptions', async () => {
    const window = await boot()
    registry.subscribe({ id: 'live', name: 'session.events', params: {} })
    await expect(registry.invoke('window.close', undefined)).resolves.toEqual({ done: true })
    registry.publish('session.events', { seq: 1 })
    fixture.createTray.mock.calls[0]![0]()
    registry.publish('session.events', { seq: 2 })
    expect(window.destroyed).toBe(false)
    expect(window.draft).toBe('unfinished prompt')
    expect(delivered).toEqual([
      { id: 'live', name: 'session.events', payload: { seq: 1 } },
      { id: 'live', name: 'session.events', payload: { seq: 2 } },
    ])
    expect(registry.subscriberCount()).toBe(1)
    expect(fixture.registerRpc).toHaveBeenCalledOnce()
  })

  it.each(['win32', 'linux', 'darwin'])(
    'hides even an idle %s window without destroying its renderer',
    async (platform) => {
      const window = await boot(platform)
      window.emit('ready-to-show')
      window.close()
      expect(window.hide).toHaveBeenCalledOnce()
      expect(window.destroyed).toBe(false)
      expect(window.draft).toBe('unfinished prompt')
      expect(fixture.app.quit).not.toHaveBeenCalled()
      expect(fixture.shutdown).not.toHaveBeenCalled()
      expect(fixture.tray.setBackgrounded).toHaveBeenLastCalledWith(true)
    },
  )

  it('does not undo an early close when the first frame finally paints', async () => {
    const window = await boot()
    window.close()
    window.emit('ready-to-show')
    expect(window.visible).toBe(false)
  })

  it.each(['tray', 'second-instance', 'activate'])(
    '%s restores and shows the same hidden renderer without registering RPC again',
    async (entry) => {
      const window = await boot()
      window.close()
      window.minimized = true
      if (entry === 'tray') fixture.createTray.mock.calls[0]![0]()
      else fixture.app.emit(entry)
      expect(window.restore).toHaveBeenCalledOnce()
      expect(window.show).toHaveBeenCalledOnce()
      expect(window.focus).toHaveBeenCalledOnce()
      expect(window.visible).toBe(true)
      expect(fixture.createWindow).toHaveBeenCalledOnce()
      expect(fixture.registerRpc).toHaveBeenCalledOnce()
      expect(fixture.tray.setBackgrounded).toHaveBeenLastCalledWith(false)
    },
  )

  it('allows explicit Quit to close a hidden window and await runtime shutdown', async () => {
    const window = await boot()
    window.close()
    fixture.app.quit()
    await vi.waitFor(() => expect(window.destroyed).toBe(true))
    expect(fixture.shutdown).toHaveBeenCalledOnce()
    expect(fixture.tray.destroy).toHaveBeenCalledOnce()
    expect(fixture.presenceStop).toHaveBeenCalledOnce()
  })

  it('keeps startup usable when the tray cannot be created, and close quits', async () => {
    fixture.createTray.mockImplementation(() => {
      throw new Error('no system tray')
    })
    const window = await boot()
    window.emit('ready-to-show')
    expect(fixture.registerRpc).toHaveBeenCalledOnce()
    expect(window.visible).toBe(true)
    window.close()
    await vi.waitFor(() => expect(fixture.shutdown).toHaveBeenCalledOnce())
  })

  it('reveals a trayless startup on the existing first-paint fallback', async () => {
    fixture.createTray.mockImplementation(() => {
      throw new Error('no system tray')
    })
    fixture.firstPaint.mockResolvedValueOnce(undefined)
    const window = await boot()
    await vi.waitFor(() => expect(window.visible).toBe(true))
    expect(fixture.registerRpc).toHaveBeenCalledOnce()
  })

  it('quits rather than hiding when its tray is destroyed', async () => {
    const window = await boot()
    fixture.tray.isDestroyed.mockReturnValue(true)
    window.close()
    expect(window.hide).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(fixture.shutdown).toHaveBeenCalledOnce())
  })

  it('reveals a hidden window if updating its tray fails', async () => {
    const window = await boot()
    fixture.tray.setBackgrounded.mockImplementation(() => {
      throw new Error('tray lost')
    })
    window.close()
    expect(window.visible).toBe(true)
    expect(window.destroyed).toBe(false)
  })

  it.each(['query-session-end', 'session-end'])(
    'does not veto Windows %s and starts shutdown',
    async (eventName) => {
      const window = await boot()
      window.close()
      const event = { preventDefault: vi.fn() }
      window.emit(eventName, event)
      expect(event.preventDefault).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(fixture.shutdown).toHaveBeenCalledOnce())
    },
  )

  it('quits on OS shutdown on platforms with powerMonitor', async () => {
    await boot('darwin')
    fixture.powerMonitor.emit('shutdown')
    await vi.waitFor(() => expect(fixture.shutdown).toHaveBeenCalledOnce())
  })

  it('quits if the sole runtime-owning webContents is unexpectedly destroyed', async () => {
    const window = await boot('darwin')
    window.destroyed = true
    window.webContents.emit('destroyed')
    fixture.app.emit('activate')
    await vi.waitFor(() => expect(fixture.shutdown).toHaveBeenCalledOnce())
    expect(fixture.registerRpc).toHaveBeenCalledOnce()
  })

  it('reveals and reloads a crashed hidden renderer without duplicating RPC ownership', async () => {
    const window = await boot()
    window.close()
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(window.visible).toBe(true)
    expect(window.webContents.reload).toHaveBeenCalledOnce()
    expect(fixture.registerRpc).toHaveBeenCalledOnce()
  })

  it('bounds an unresponsive shutdown so Quit remains usable', async () => {
    vi.useFakeTimers()
    fixture.shutdown.mockImplementation(() => new Promise(() => undefined))
    await boot()
    fixture.app.quit()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fixture.app.exit).toHaveBeenCalledWith(0)
  })

  it('does not reveal a quitting window or start update checks after a late first frame', async () => {
    const window = await boot()
    fixture.app.quit()
    window.emit('ready-to-show')
    expect(window.show).not.toHaveBeenCalled()
    expect(fixture.startUpdates).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(window.destroyed).toBe(true))
  })

  it('quits on synchronous startup failure without creating another runtime', async () => {
    fixture.registerRpc.mockImplementation(() => {
      throw new Error('RPC startup failed')
    })
    await boot()
    expect(fixture.app.quit).toHaveBeenCalled()
    fixture.app.emit('activate')
    expect(fixture.registerRpc).toHaveBeenCalledOnce()
  })

  it('quits on main-frame load failure but ignores aborted navigation and guest failures', async () => {
    const window = await boot()
    window.webContents.emit('did-fail-load', {}, -3, 'aborted', 'app', true)
    window.webContents.emit('did-fail-load', {}, -2, 'guest failed', 'guest', false)
    expect(fixture.app.quit).not.toHaveBeenCalled()
    window.webContents.emit('did-fail-load', {}, -2, 'app failed', 'app', true)
    await vi.waitFor(() => expect(fixture.shutdown).toHaveBeenCalledOnce())
  })
})
