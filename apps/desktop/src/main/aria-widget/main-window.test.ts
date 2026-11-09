// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MainWindowLifecycle } from './main-window'
import { STARTUP_FALLBACK_MS } from '../startup-gate'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

it('rebinds RPC and widget callbacks on tray, dock and second-instance reopen', () => {
  let id = 0
  const create = vi.fn(() => ({
    id: ++id,
    destroyed: false,
    minimized: false,
    paint: (): void => undefined,
    once(_event: 'ready-to-show', callback: () => void) {
      this.paint = callback
    },
    isDestroyed() {
      return this.destroyed
    },
    isMinimized() {
      return this.minimized
    },
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }))
  let invoke = () => 0
  let openSettings = () => 0
  const bind = vi.fn((window: ReturnType<typeof create>) => {
    invoke = () => window.id
    openSettings = () => window.id
  })
  const windows = new MainWindowLifecycle(create, bind)
  for (const entry of ['startup', 'tray', 'dock', 'second-instance']) {
    if (entry !== 'startup') windows.show()
    const window = windows.ensure()
    expect(invoke()).toBe(window.id)
    expect(openSettings()).toBe(window.id)
    expect(bind).toHaveBeenCalledTimes(window.id)
    window.destroyed = true
  }
  expect(create).toHaveBeenCalledTimes(4)
})

it('restores a live minimized window without rebinding the widget', async () => {
  const window = {
    paint: (): void => undefined,
    once(_event: 'ready-to-show', callback: () => void) {
      this.paint = callback
    },
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
  const bind = vi.fn()
  const windows = new MainWindowLifecycle(() => window, bind)
  windows.ensure()
  window.paint()
  await vi.advanceTimersByTimeAsync(0)
  windows.show()
  expect(bind).toHaveBeenCalledOnce()
  expect(window.restore).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
})

it('defers tray and second-instance requests until first paint, including replacement windows', async () => {
  const create = () => ({
    destroyed: false,
    paint: (): void => undefined,
    once(_event: 'ready-to-show', callback: () => void) {
      this.paint = callback
    },
    isDestroyed() {
      return this.destroyed
    },
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  })
  const windows = new MainWindowLifecycle(create, vi.fn())
  const first = windows.ensure()
  windows.show()
  windows.show()
  expect(first.show).not.toHaveBeenCalled()
  expect(first.focus).not.toHaveBeenCalled()
  first.paint()
  await vi.advanceTimersByTimeAsync(0)
  expect(first.show).toHaveBeenCalledOnce()
  expect(first.focus).toHaveBeenCalledOnce()
  first.destroyed = true
  windows.show()
  const second = windows.ensure()
  first.paint()
  await vi.advanceTimersByTimeAsync(0)
  expect(second.show).not.toHaveBeenCalled()
  second.paint()
  await vi.advanceTimersByTimeAsync(0)
  expect(second.show).toHaveBeenCalledOnce()
  expect(second.focus).toHaveBeenCalledOnce()
})

it('shows a requested window on the startup fallback even if it never paints', async () => {
  const window = {
    once: vi.fn(),
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
  const windows = new MainWindowLifecycle(() => window, vi.fn())
  windows.show()
  await vi.advanceTimersByTimeAsync(STARTUP_FALLBACK_MS - 1)
  expect(window.show).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(window.show).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
})
