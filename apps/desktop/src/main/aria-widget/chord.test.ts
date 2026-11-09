// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ChordTracker, defaultShortcut, parseChord, type HookKey } from './chord'

const keys = {
  Space: 57,
  Escape: 1,
  Ctrl: 29,
  CtrlRight: 3613,
  Alt: 56,
  AltRight: 3640,
  Meta: 3675,
  MetaRight: 3676,
  Shift: 42,
  ShiftRight: 54,
  A: 30,
  F24: 107,
}
const event = (keycode: number, modifiers: Partial<HookKey> = {}): HookKey => ({
  keycode,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers,
})

describe('speech chord', () => {
  it('uses platform defaults and accepts settings aliases', () => {
    expect(defaultShortcut('win32')).toBe('ctrl+space')
    expect(defaultShortcut('linux')).toBe('ctrl+space')
    expect(defaultShortcut('darwin')).toBe('alt+space')
    expect(parseChord(' Option + Space ', keys, 'darwin')?.modifiers.altKey).toBe(true)
    expect(parseChord('CommandOrControl+F24', keys, 'darwin')?.modifiers.metaKey).toBe(true)
    expect(parseChord('CmdOrCtrl+A', keys, 'win32')?.modifiers.ctrlKey).toBe(true)
  })

  it.each([
    'space',
    'ctrl',
    'ctrl+unknown',
    'ctrl+space+a',
    'ctrl++space',
    'ctrl+ctrl+space',
    'ctrl+escape',
    'ctrl+esc',
    'ctrl+CtrlRight',
  ])('does not arm malformed or ambiguous settings: %s', (shortcut) => {
    expect(parseChord(shortcut, keys, 'win32')).toBeNull()
  })

  it('requires the exact modifiers, ignores repeats and releases either side of a modifier', () => {
    const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
    expect(tracker.down(event(keys.Space))).toBeNull()
    expect(tracker.down(event(keys.Space, { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBe('down')
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBeNull()
    expect(tracker.up(event(keys.A))).toBeNull()
    expect(tracker.up(event(keys.CtrlRight))).toBe('up')
    expect(tracker.up(event(keys.Space))).toBeNull()
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBe('down')
    expect(tracker.up(event(keys.Space))).toBe('up')
  })

  it('cancels with Escape and cannot restart on a repeat before release', () => {
    const tracker = new ChordTracker(parseChord('alt+space', keys, 'darwin')!, keys.Escape)
    expect(tracker.down(event(keys.Space, { altKey: true }))).toBe('down')
    expect(tracker.down(event(keys.Escape))).toBe('cancel')
    expect(tracker.down(event(keys.Space, { altKey: true }))).toBeNull()
    expect(tracker.up(event(keys.Space))).toBe('up')
    expect(tracker.down(event(keys.Space, { altKey: true }))).toBe('down')
  })

  it('tracks modifier events when native masks lag and retains either pressed side', () => {
    const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
    tracker.down(event(keys.Ctrl))
    tracker.down(event(keys.CtrlRight))
    expect(tracker.down(event(keys.Space))).toBe('down')
    expect(tracker.up(event(keys.Ctrl))).toBeNull()
    expect(tracker.up(event(keys.CtrlRight))).toBe('up')
    expect(tracker.down(event(keys.Space))).toBeNull()
  })
})
