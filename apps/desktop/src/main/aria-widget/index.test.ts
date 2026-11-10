// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@ari/contracts/settings'
import type { HookKey } from './chord'
import type { BrowserWindow } from 'electron'

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
  UiohookKey: {
    Space: 57,
    D: 32,
    Escape: 1,
    Ctrl: 29,
    CtrlRight: 3613,
    Alt: 56,
    AltRight: 3640,
    F8: 66,
  },
}))
vi.mock('../speech/dictation-target', () => ({ prepareDictation: async () => undefined }))

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
  // These fixtures exercise Windows chords; chord.test.ts covers every platform.
  vi.stubGlobal('process', { ...process, platform: 'win32' })
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
  vi.unstubAllGlobals()
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

it('accepts a fresh hold after reset once the shortcut key has stayed quiet for one second', async () => {
  widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
  await widget.configure(configured)
  mock.keys.get('keydown')?.(key(57))
  mock.powerEvents.get('lock-screen')!()
  mock.powerEvents.get('suspend')!()
  await vi.advanceTimersByTimeAsync(999)
  mock.keys.get('keydown')?.(key(57))
  expect(mock.windows[0]!.showInactive).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(999)
  mock.keys.get('keydown')?.(key(57))
  expect(mock.windows[0]!.showInactive).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  mock.keys.get('keydown')?.(key(57))
  expect(mock.windows[0]!.showInactive).toHaveBeenCalledTimes(2)
})

it('starts recording immediately with a function key alone', async () => {
  widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
  await widget.configure({ ...configured, speech: { enabled: true, shortcut: 'f8' } } as Settings)
  mock.keys.get('keydown')!({ ...key(66), ctrlKey: false })
  expect(mock.windows[0]!.showInactive).toHaveBeenCalledOnce()
  expect(mock.windows[0]!.webContents.send).toHaveBeenLastCalledWith(
    'ari:ariaWidget.state',
    expect.objectContaining({ phase: 'listening' }),
  )
  expect([...mock.keys.keys()]).toEqual(['keydown', 'keyup'])
})

it('uses the new platform default when the shortcut is empty', async () => {
  widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
  await widget.configure({ ...configured, speech: { enabled: true, shortcut: '' } } as Settings)
  mock.keys.get('keydown')!({ ...key(57), altKey: true })
  expect(mock.windows[0]!.showInactive).toHaveBeenCalledOnce()
})

it.each(['alt-right', 'ctrl', 'alt+f4', 'ctrl+tab', 'ctrl+arrowleft'])(
  'does not start the hook for an unsupported or reserved shortcut: %s',
  async (shortcut) => {
    widget = new AriaWidget({ invoke: async () => ({ ready: true }), openSettings: vi.fn() })
    await widget.configure({ ...configured, speech: { enabled: true, shortcut } } as Settings)
    expect(mock.start).not.toHaveBeenCalled()
    expect(mock.windows).toHaveLength(0)
  },
)

it.each(['transcribing', 'sending'] as const)(
  'ignores new shortcut presses and typing while %s',
  async (phase) => {
    let opened!: (value: { sessionId: string }) => void
    const dispatch = vi.fn(async () => ({ accepted: true }))
    widget = new AriaWidget({
      invoke: async (method) => {
        if (method === 'speech.status') return { ready: true }
        if (method === 'aria.open') {
          if (phase === 'sending')
            return new Promise((resolve) => {
              opened = resolve
            })
          return { sessionId: 'aria' }
        }
        return dispatch()
      },
      openSettings: vi.fn(),
    })
    await widget.configure({ ...configured, speech: { enabled: true, shortcut: 'f8' } } as Settings)
    mock.keys.get('keydown')!({ ...key(66), ctrlKey: false })
    mock.keys.get('keyup')!({ ...key(66), ctrlKey: false })
    const sender = mock.windows[0]!.webContents
    const complete = mock.handlers.get('ari:ariaWidget.complete')!
    const pending =
      phase === 'sending' ? complete({ sender }, { id: 1, text: 'Keep this dictation' }) : undefined
    const previous = sender.send.mock.calls.at(-1)![1]
    const count = sender.send.mock.calls.length
    mock.keys.get('keydown')!({ ...key(66), ctrlKey: false })
    mock.keys.get('keydown')!({ ...key(30), ctrlKey: false })
    mock.keys.get('keydown')!({ ...key(1), ctrlKey: false })
    mock.keys.get('keyup')!({ ...key(66), ctrlKey: false })
    await vi.advanceTimersByTimeAsync(250)
    expect(sender.send).toHaveBeenCalledTimes(count)
    expect(sender.send.mock.calls.at(-1)![1]).toBe(previous)
    if (phase === 'sending') {
      opened({ sessionId: 'aria' })
      await pending
    } else await complete({ sender }, { id: 1, text: 'Keep this dictation' })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(sender.send).toHaveBeenLastCalledWith(
      'ari:ariaWidget.state',
      expect.objectContaining({ phase: 'sent', id: 1 }),
    )
  },
)

it.each(['sent', 'error', 'setup'] as const)(
  'replaces the %s pill with an immediate new dictation',
  async (phase) => {
    const dispatch = vi.fn(async () => ({ accepted: true }))
    widget = new AriaWidget({
      invoke: async (method) => {
        if (method === 'speech.status') return { ready: true }
        if (method === 'aria.open') return { sessionId: 'aria' }
        return dispatch()
      },
      openSettings: vi.fn(),
    })
    await widget.configure({ ...configured, speech: { enabled: true, shortcut: 'f8' } } as Settings)
    mock.keys.get('keydown')!({ ...key(66), ctrlKey: false })
    const sender = mock.windows[0]!.webContents
    const complete = mock.handlers.get('ari:ariaWidget.complete')!
    const error = mock.handlers.get('ari:ariaWidget.error')!
    if (phase === 'sent') {
      mock.keys.get('keyup')!({ ...key(66), ctrlKey: false })
      await complete({ sender }, { id: 1, text: 'Old message' })
    } else {
      await error({ sender }, { id: 1, text: 'Old hint', setup: phase === 'setup' })
      mock.keys.get('keyup')!({ ...key(66), ctrlKey: false })
    }
    mock.keys.get('keydown')!({ ...key(66), ctrlKey: false })
    expect(sender.send).toHaveBeenLastCalledWith(
      'ari:ariaWidget.state',
      expect.objectContaining({ id: 2, phase: 'listening', text: '', setup: false }),
    )
    await complete({ sender }, { id: 1, text: 'Late result' })
    await error({ sender }, { id: 1, text: 'Late error' })
    expect(sender.send).toHaveBeenLastCalledWith(
      'ari:ariaWidget.state',
      expect.objectContaining({ id: 2, phase: 'listening' }),
    )
    mock.keys.get('keyup')!({ ...key(66), ctrlKey: false })
    await complete({ sender }, { id: 2, text: 'New message' })
    expect(sender.send).toHaveBeenLastCalledWith(
      'ari:ariaWidget.state',
      expect.objectContaining({ id: 2, phase: 'sent', text: 'New message' }),
    )
    expect(dispatch).toHaveBeenCalledTimes(phase === 'sent' ? 2 : 1)
  },
)

it.each([
  ['listening', 120000],
  ['transcribing', 45000],
  ['sent', 1500],
] as const)('uses monotonic time despite wall-clock jumps during %s', async (phase, timeout) => {
  widget = new AriaWidget({
    invoke: async (method) =>
      method === 'aria.open' ? { sessionId: 'aria' } : { ready: true, accepted: true },
    openSettings: vi.fn(),
  })
  await widget.configure({ ...configured, speech: { enabled: true, shortcut: 'f8' } } as Settings)
  mock.keys.get('keydown')!({ ...key(66), ctrlKey: false })
  const sender = mock.windows[0]!.webContents
  if (phase !== 'listening') mock.keys.get('keyup')!({ ...key(66), ctrlKey: false })
  if (phase === 'sent')
    await mock.handlers.get('ari:ariaWidget.complete')!({ sender }, { id: 1, text: 'Done' })
  vi.setSystemTime(Date.now() + 3600000)
  await vi.advanceTimersByTimeAsync(timeout - 1)
  expect(sender.send).toHaveBeenLastCalledWith(
    'ari:ariaWidget.state',
    expect.objectContaining({ phase }),
  )
  vi.setSystemTime(Date.now() - 7200000)
  await vi.advanceTimersByTimeAsync(1)
  expect(sender.send).toHaveBeenLastCalledWith(
    'ari:ariaWidget.state',
    expect.objectContaining({ phase: phase === 'sent' ? 'hidden' : 'error' }),
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
    speech: { enabled: true, shortcut: 'f8' },
  } as Settings)
  expect(mock.windows).toHaveLength(3)
  expect(vi.getTimerCount()).toBe(0)
  mock.keys.get('keydown')?.({ ...key(66), ctrlKey: false })
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

const generalKey = (): HookKey => ({ ...key(32), altKey: true })
it('captures the general target before showing the pill and inserts once without opening Aria', async () => {
  const insert = vi.fn(async () => undefined)
  const cancel = vi.fn()
  const invoke = vi.fn(async (method: string) => ({ ready: method === 'speech.status' }))
  const capture = vi.fn(async () => {
    expect(mock.windows[0]!.showInactive).not.toHaveBeenCalled()
    return { insert, cancel }
  })
  widget = new AriaWidget({ invoke, openSettings: vi.fn(), captureTarget: capture })
  await widget.configure(configured)
  mock.keys.get('keydown')!(generalKey())
  expect(capture).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(0)
  mock.keys.get('keyup')!(generalKey())
  const complete = mock.handlers.get('ari:ariaWidget.complete')!
  const sender = mock.windows[0]!.webContents
  await complete({ sender }, { id: 1, text: 'general draft' })
  await complete({ sender }, { id: 1, text: 'duplicate' })
  expect(insert).toHaveBeenCalledOnce()
  expect(insert).toHaveBeenCalledWith('general draft', expect.any(Function))
  expect(invoke.mock.calls.map(([method]) => method)).toEqual(['speech.status'])
  expect(cancel).toHaveBeenCalledOnce()
})

it('discards a quick release before target acquisition and cancels the late target', async () => {
  const insert = vi.fn()
  const cancel = vi.fn()
  let resolve!: (target: { insert: typeof insert; cancel: typeof cancel }) => void
  widget = new AriaWidget({
    invoke: async () => ({ ready: true }),
    openSettings: vi.fn(),
    captureTarget: () =>
      new Promise((r) => {
        resolve = r
      }),
  })
  await widget.configure(configured)
  mock.keys.get('keydown')!(generalKey())
  mock.keys.get('keyup')!(generalKey())
  resolve({ insert, cancel })
  await vi.advanceTimersByTimeAsync(0)
  expect(cancel).toHaveBeenCalledOnce()
  expect(insert).not.toHaveBeenCalled()
  expect(mock.windows[0]!.showInactive).not.toHaveBeenCalled()
})

it.each(['escape', 'disable', 'empty', 'unavailable'])(
  'never falls back to Aria for %s general dictation',
  async (reason) => {
    const insert = vi.fn(async () => {
      if (reason === 'unavailable') throw new Error('target unavailable')
    })
    const invoke = vi.fn(async (method: string) => ({ ready: method === 'speech.status' }))
    widget = new AriaWidget({
      invoke,
      openSettings: vi.fn(),
      captureTarget: async () => ({ insert, cancel: vi.fn() }),
    })
    await widget.configure(configured)
    mock.keys.get('keydown')!(generalKey())
    await vi.advanceTimersByTimeAsync(0)
    mock.keys.get('keyup')!(generalKey())
    if (reason === 'escape') mock.keys.get('keydown')!(key(1))
    if (reason === 'disable')
      await widget.configure({ ...configured, speech: { ...configured.speech, enabled: false } })
    await mock.handlers.get('ari:ariaWidget.complete')!(
      { sender: mock.windows[0]!.webContents },
      { id: 1, text: reason === 'empty' ? '  ' : 'draft' },
    )
    expect(invoke.mock.calls.map(([method]) => method)).toEqual(['speech.status'])
    expect(insert).toHaveBeenCalledTimes(reason === 'unavailable' ? 1 : 0)
  },
)

it('reserves capture through transcription and blocks both shortcuts while a composer owns it', async () => {
  const contents = { on: vi.fn(), removeListener: vi.fn(), isDestroyed: () => false }
  const main = { webContents: contents } as unknown as BrowserWindow
  widget = new AriaWidget({
    invoke: async () => ({ ready: true }),
    openSettings: vi.fn(),
    mainWindow: () => main,
  })
  await widget.configure(configured)
  const acquire = mock.handlers.get('ari:speechCapture.acquire')!
  const release = mock.handlers.get('ari:speechCapture.release')!
  const token = acquire({ sender: contents })
  expect(() => acquire({ sender: contents })).toThrow('Another dictation')
  expect(() => acquire({ sender: {} })).toThrow('Rejected dictation sender')
  mock.keys.get('keydown')!(key(57))
  mock.keys.get('keyup')!(key(57))
  mock.keys.get('keydown')!(generalKey())
  mock.keys.get('keyup')!(generalKey())
  expect(mock.windows[0]!.showInactive).not.toHaveBeenCalled()
  release({ sender: contents }, 'wrong-token')
  expect(() => acquire({ sender: contents })).toThrow('Another dictation')
  release({ sender: contents }, token)
  mock.keys.get('keydown')!(key(57))
  mock.keys.get('keyup')!(key(57))
  expect(() => acquire({ sender: contents })).toThrow('Another dictation')
})
