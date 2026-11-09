// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@ari/contracts/settings'
import type { HookKey } from './chord'

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, params?: unknown) => unknown>(),
  keys: new Map<string, (event: HookKey) => void>(),
  windows: [] as {
    webContents: { send: ReturnType<typeof vi.fn>; isDestroyed(): boolean }
    showInactive: ReturnType<typeof vi.fn>
    options: unknown
  }[],
  start: vi.fn(),
  stop: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: { sender: unknown }, params?: unknown) => unknown) =>
      mock.handlers.set(channel, handler),
    removeHandler: (channel: string) => mock.handlers.delete(channel),
  },
  nativeTheme: { on: vi.fn(), removeListener: vi.fn(), shouldUseDarkColors: true },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  },
  BrowserWindow: class {
    private closed: (() => void) | null = null
    private destroyed = false
    private visible = false
    webContents = {
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    }
    showInactive = vi.fn(() => {
      this.visible = true
    })
    constructor(readonly options: unknown) {
      mock.windows.push(this)
      queueMicrotask(() =>
        mock.handlers.get('ari:ariaWidget.ready')?.({ sender: this.webContents }),
      )
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    isVisible(): boolean {
      return this.visible
    }
    hide(): void {
      this.visible = false
    }
    setBounds = vi.fn()
    setAlwaysOnTop = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    once(event: string, callback: () => void): void {
      if (event === 'closed') this.closed = callback
    }
    loadFile = async (): Promise<void> => undefined
    loadURL = async (): Promise<void> => undefined
    destroy(): void {
      this.destroyed = true
      this.closed?.()
    }
  },
}))
vi.mock('uiohook-napi', () => ({
  uIOhook: {
    on: (event: string, listener: (event: HookKey) => void) => mock.keys.set(event, listener),
    removeListener: (event: string) => mock.keys.delete(event),
    start: mock.start,
    stop: mock.stop,
  },
  UiohookKey: { Space: 57, Escape: 1, Ctrl: 29, CtrlRight: 3613, Alt: 56, AltRight: 3640 },
}))

import { AriaWidget } from './index'
let widget: AriaWidget
const configured = {
  ...defaultSettings,
  speech: { enabled: true, shortcut: 'ctrl+space' },
} as Settings
const key = (keycode: number): HookKey => ({
  keycode,
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  metaKey: false,
})
beforeEach(() => {
  vi.useFakeTimers()
  mock.handlers.clear()
  mock.keys.clear()
  mock.windows.length = 0
  mock.start.mockClear()
  mock.stop.mockClear()
})
afterEach(() => {
  widget?.close()
  vi.useRealTimers()
})

it('starts only for configured and enabled speech and tears down on disable', async () => {
  let ready = false
  widget = new AriaWidget({ invoke: async () => ({ ready }), openSettings: vi.fn() })
  await widget.configure(configured)
  expect(mock.start).not.toHaveBeenCalled()
  expect(mock.windows).toHaveLength(0)
  ready = true
  await widget.configure(configured)
  expect(mock.start).toHaveBeenCalledOnce()
  expect(mock.windows[0]?.options).toMatchObject({
    focusable: false,
    frame: false,
    skipTaskbar: true,
    transparent: true,
  })
  mock.keys.get('keydown')?.(key(57))
  expect(mock.windows[0]?.showInactive).toHaveBeenCalledOnce()
  await widget.configure({
    ...configured,
    speech: { enabled: false, shortcut: 'ctrl+space' },
  } as Settings)
  expect(mock.stop).toHaveBeenCalledOnce()
  expect(mock.keys.size).toBe(0)
})

it('keeps the hook and hold when only appearance changes', async () => {
  widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
  await widget.configure(configured)
  mock.keys.get('keydown')?.(key(57))
  await widget.configure({
    ...configured,
    appearance: { ...configured.appearance, themeId: 'porcelain', mode: 'porcelain' },
  })
  expect(mock.start).toHaveBeenCalledOnce()
  expect(mock.stop).not.toHaveBeenCalled()
  expect(mock.windows[0]?.webContents.send).toHaveBeenLastCalledWith(
    'ari:ariaWidget.state',
    expect.objectContaining({ phase: 'listening', theme: 'porcelain' }),
  )
})

it('rejects other windows and arbitrary RPC capabilities', async () => {
  widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
  await widget.configure(configured)
  const handler = mock.handlers.get('ari:ariaWidget.speech')!
  expect(() => handler({ sender: {} }, { method: 'speech.status' })).toThrow(
    'Rejected widget sender',
  )
  await expect(
    handler({ sender: mock.windows[0]!.webContents }, { method: 'command.dispatch' }),
  ).rejects.toThrow('Rejected widget method')
})

it('hands off the current release once, ignoring repeated and cancelled results', async () => {
  const dispatch = vi.fn(async () => ({ accepted: true }))
  const invoke = vi.fn(async (method: string) => {
    if (method === 'speech.status') return { ready: true }
    if (method === 'aria.open') return { sessionId: 'aria' }
    if (method === 'session.load') return { activeTurnId: null }
    return dispatch()
  })
  widget = new AriaWidget({ invoke, openSettings: vi.fn() })
  await widget.configure(configured)
  mock.keys.get('keydown')?.(key(57))
  mock.keys.get('keyup')?.(key(57))
  const sender = mock.windows[0]!.webContents
  const complete = mock.handlers.get('ari:ariaWidget.complete')!
  await Promise.all([
    complete({ sender }, { id: 1, text: 'Hello' }),
    complete({ sender }, { id: 1, text: 'Hello' }),
  ])
  expect(dispatch).toHaveBeenCalledOnce()
  expect(sender.send).toHaveBeenLastCalledWith(
    'ari:ariaWidget.state',
    expect.objectContaining({ phase: 'sent' }),
  )
  mock.keys.get('keydown')?.(key(57))
  mock.keys.get('keydown')?.(key(1))
  await complete({ sender }, { id: 2, text: 'Cancelled' })
  expect(dispatch).toHaveBeenCalledOnce()
})
