// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SnapshotShortcut, snapshotAccelerator } from './shortcut'

describe('SnapshotShortcut', () => {
  it('registers once, replaces atomically and only releases its own chord', () => {
    const registry = { register: vi.fn(() => true), unregister: vi.fn() }
    const capture = vi.fn()
    const shortcut = new SnapshotShortcut(registry, capture)
    shortcut.configure('ctrl+alt+p')
    shortcut.configure('ctrl+alt+p')
    expect(registry.register).toHaveBeenCalledTimes(1)
    expect(registry.register).toHaveBeenCalledWith('Control+Alt+P', capture)
    shortcut.configure('ctrl+shift+f12')
    expect(registry.unregister).toHaveBeenCalledWith('Control+Alt+P')
    shortcut.dispose()
    expect(registry.unregister).toHaveBeenLastCalledWith('Control+Shift+F12')
    expect(shortcut.registered).toBe(false)
  })
  it('preserves the old shortcut when the OS refuses a replacement', () => {
    const registry = { register: vi.fn(() => true), unregister: vi.fn() }
    const shortcut = new SnapshotShortcut(registry, vi.fn())
    shortcut.configure('ctrl+alt+p')
    registry.register.mockReturnValue(false)
    expect(() => shortcut.configure('f12')).toThrow('could not be registered')
    expect(shortcut.registered).toBe(true)
    expect(registry.unregister).not.toHaveBeenCalled()
  })
  it('translates physical punctuation and Mac modifiers', () => {
    expect(snapshotAccelerator('alt+meta+slash')).toBe('Alt+Super+/')
  })
})
