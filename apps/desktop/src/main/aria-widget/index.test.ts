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
    events: Map<string, () => void>
  }[],
  powerEvents: new Map<string, () => void>(),
  appEvents: new Map<string, () => void>(),
  start: vi.fn(),
  stop: vi.fn(),
  load: vi.fn(async () => undefined),
  autoReady: true,
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: { sender: unknown }, params?: unknown) => unknown) =>
      mock.handlers.set(channel, handler),
    removeHandler: (channel: string) => mock.handlers.delete(channel),
  },
  powerMonitor: {
    on: (event: string, callback: () => void) => mock.powerEvents.set(event, callback),
    removeListener: (event: string) => mock.powerEvents.delete(event),
  },
  app: {
    on: (event: string, callback: () => void) => mock.appEvents.set(event, callback),
    removeListener: (event: string) => mock.appEvents.delete(event),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  },
  BrowserWindow: class {
    private closed: (() => void) | null = null
    private destroyed = false
    private visible = false
    events = new Map<string, () => void>()
    webContents = {
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: vi.fn(),
      on: (event: string, callback: () => void) => this.events.set(event, callback),
    }
    showInactive = vi.fn(() => {
      this.visible = true
    })
    constructor(readonly options: unknown) {
      mock.windows.push(this)
      if (mock.autoReady)
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
      this.events.set(event, callback)
      if (event === 'closed') this.closed = callback
    }
    loadFile = mock.load
    loadURL = mock.load
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
  mock.powerEvents.clear()
  mock.appEvents.clear()
  mock.start.mockClear()
  mock.stop.mockClear()
  mock.load.mockReset().mockResolvedValue(undefined)
  mock.autoReady = true
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

it.each(['lock-screen', 'suspend'])('clears input and cancels recording on %s', async (event) => {
  widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
  await widget.configure(configured)
  mock.keys.get('keydown')?.(key(57))
  mock.powerEvents.get(event)?.()
  expect(mock.windows[0]?.webContents.send).toHaveBeenLastCalledWith(
    'ari:ariaWidget.state',
    expect.objectContaining({ phase: 'hidden' }),
  )
  mock.keys.get('keydown')?.({ ...key(57), ctrlKey: false })
  expect(mock.windows[0]?.showInactive).toHaveBeenCalledTimes(1)
  mock.keys.get('keydown')?.(key(57))
  expect(mock.windows[0]?.showInactive).toHaveBeenCalledTimes(1)
  mock.keys.get('keyup')?.(key(57))
  mock.keys.get('keydown')?.(key(57))
  expect(mock.windows[0]?.showInactive).toHaveBeenCalledTimes(2)
})

it.each(['browser-window-blur', 'lock-screen', 'suspend'])(
  'preserves released dictation through transcription and sending on %s',
  async (event) => {
    let opened!: (value: { sessionId: string }) => void
    const dispatch = vi.fn(async () => ({ accepted: true }))
    widget = new AriaWidget({
      invoke: async (method) => {
        if (method === 'speech.status') return { ready: true }
        if (method === 'aria.open')
          return new Promise((resolve) => {
            opened = resolve
          })
        return dispatch()
      },
      openSettings: vi.fn(),
    })
    await widget.configure(configured)
    const emit = () =>
      (event === 'browser-window-blur' ? mock.appEvents : mock.powerEvents).get(event)?.()
    mock.keys.get('keydown')?.(key(57))
    if (event === 'browser-window-blur') {
      expect(mock.appEvents.has(event)).toBe(false)
      emit()
      expect(mock.windows[0]!.webContents.send).toHaveBeenLastCalledWith(
        'ari:ariaWidget.state',
        expect.objectContaining({ phase: 'listening' }),
      )
    }
    mock.keys.get('keyup')?.(key(57))
    const sender = mock.windows[0]!.webContents
    emit()
    expect(sender.send).toHaveBeenLastCalledWith(
      'ari:ariaWidget.state',
      expect.objectContaining({ phase: 'transcribing' }),
    )
    const sending = mock.handlers.get('ari:ariaWidget.complete')!(
      { sender },
      { id: 1, text: 'Keep this' },
    )
    emit()
    opened({ sessionId: 'aria' })
    await sending
    expect(dispatch).toHaveBeenCalledOnce()
    expect(sender.send).toHaveBeenLastCalledWith(
      'ari:ariaWidget.state',
      expect.objectContaining({ phase: 'sent' }),
    )
  },
)

it('transcribes when a later event reveals a missed modifier release', async () => {
  widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
  await widget.configure(configured)
  mock.keys.get('keydown')?.(key(57))
  mock.keys.get('keydown')?.({ ...key(30), ctrlKey: false })
  expect(mock.windows[0]!.webContents.send).toHaveBeenLastCalledWith(
    'ari:ariaWidget.state',
    expect.objectContaining({ phase: 'transcribing' }),
  )
})

it('ignores stale renderer crash, load failure and closed callbacks after replacement', async () => {
  let rejectLoad!: (error: Error) => void
  mock.load.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectLoad = reject
      }),
  )
  widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
  await widget.configure(configured)
  const old = mock.windows[0]!
  old.events.get('render-process-gone')!()
  mock.autoReady = false
  await vi.advanceTimersByTimeAsync(1_000)
  expect(mock.windows).toHaveLength(2)
  old.events.get('render-process-gone')!()
  old.events.get('closed')!()
  rejectLoad(new Error('old navigation failed'))
  await Promise.resolve()
  expect(vi.getTimerCount()).toBe(0)
  expect(mock.start).toHaveBeenCalledOnce()
  const replacement = mock.windows[1]!
  await mock.handlers.get('ari:ariaWidget.ready')!({ sender: replacement.webContents })
  await Promise.resolve()
  expect(mock.start).toHaveBeenCalledTimes(2)
  mock.keys.get('keydown')?.(key(57))
  expect(replacement.showInactive).toHaveBeenCalledOnce()
})

it('preserves crash backoff through unrelated settings updates, but re-arms for a shortcut change', async () => {
  widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
  await widget.configure(configured)
  mock.windows[0]!.events.get('render-process-gone')!()
  await vi.advanceTimersByTimeAsync(500)
  await widget.configure({
    ...configured,
    appearance: { ...configured.appearance, themeId: 'porcelain' },
  })
  await widget.configure(configured)
  expect(mock.windows).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(499)
  expect(mock.windows).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(mock.windows).toHaveLength(2)
  mock.windows[1]!.events.get('render-process-gone')!()
  await widget.configure({
    ...configured,
    speech: { enabled: true, shortcut: 'alt-right' },
  } as Settings)
  expect(mock.windows).toHaveLength(3)
  expect(vi.getTimerCount()).toBe(0)
  mock.keys.get('keydown')?.({ ...key(3640), ctrlKey: false, altKey: true })
  expect(mock.windows[2]!.showInactive).toHaveBeenCalledOnce()
})

it('recreates and re-arms after crashes with increasing backoff, then cancels recovery on disable', async () => {
  widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
  await widget.configure(configured)
  mock.windows[0]!.events.get('render-process-gone')!()
  expect(mock.keys.size).toBe(0)
  await vi.advanceTimersByTimeAsync(999)
  expect(mock.windows).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(mock.windows).toHaveLength(2)
  expect(mock.start).toHaveBeenCalledTimes(2)
  mock.windows[1]!.events.get('render-process-gone')!()
  await vi.advanceTimersByTimeAsync(1_999)
  expect(mock.windows).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(mock.windows).toHaveLength(3)
  mock.windows[2]!.events.get('render-process-gone')!()
  await widget.configure(defaultSettings)
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(mock.windows).toHaveLength(3)
})

it('arms one deadline only while active and removes all timers and signals on close', async () => {
  widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
  expect(vi.getTimerCount()).toBe(0)
  await widget.configure(configured)
  expect(vi.getTimerCount()).toBe(0)
  mock.keys.get('keydown')?.(key(57))
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(vi.getTimerCount()).toBe(1)
  expect(mock.windows[0]?.webContents.send).toHaveBeenLastCalledWith(
    'ari:ariaWidget.state',
    expect.objectContaining({ phase: 'error' }),
  )
  await vi.advanceTimersByTimeAsync(6_000)
  expect(vi.getTimerCount()).toBe(0)
  widget.close()
  expect(mock.powerEvents.size).toBe(0)
  expect(mock.appEvents.size).toBe(0)
})

it('uses the appearance theme already resolved by the main renderer', async () => {
  widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
  await widget.configure({
    ...configured,
    appearance: { ...configured.appearance, mode: 'system', themeId: 'verdant' },
  })
  mock.keys.get('keydown')?.(key(57))
  expect(mock.windows[0]?.webContents.send).toHaveBeenLastCalledWith(
    'ari:ariaWidget.state',
    expect.objectContaining({ theme: 'verdant' }),
  )
})
