// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { MainWindowLifecycle } from './main-window'

it('rebinds RPC and widget callbacks on tray, dock and second-instance reopen', () => {
  let id = 0
  const create = vi.fn(() => ({
    id: ++id,
    destroyed: false,
    minimized: false,
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

it('restores a live minimized window without rebinding the widget', () => {
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
  const bind = vi.fn()
  const windows = new MainWindowLifecycle(() => window, bind)
  windows.ensure()
  windows.show()
  expect(bind).toHaveBeenCalledOnce()
  expect(window.restore).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
})
