// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ChordTracker, defaultShortcut, parseChord, shortcutError, type HookKey } from './chord'

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
  D: 32,
  F8: 66,
  F24: 107,
  Enter: 28,
  Tab: 15,
  Delete: 3667,
  ArrowLeft: 57419,
}
const event = (keycode: number, modifiers: Partial<HookKey> = {}): HookKey => ({
  keycode,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers,
})
const allowedKeys = [
  'space',
  'enter',
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'0123456789',
  ...Array.from({ length: 24 }, (_, i) => 'f' + (i + 1)),
  'comma',
  'period',
  'slash',
  'semicolon',
  'quote',
  'backquote',
  'minus',
  'equal',
  'bracketleft',
  'bracketright',
  'backslash',
]

describe('speech shortcut format', () => {
  it.each(['win32', 'linux', 'darwin'])('arms the default for %s', (platform) => {
    expect(defaultShortcut(platform)).toBe(
      platform === 'darwin' ? 'shift+meta+space' : 'ctrl+alt+space',
    )
    expect(parseChord(defaultShortcut(platform), keys, platform)).not.toBeNull()
  })

  it.each(allowedKeys)('accepts a modifier with the supported key %s', (key) => {
    const chord = parseChord('ctrl+' + key, { ...keys, [key]: 1000 }, 'win32')
    expect(chord?.keycode).toBe(1000)
    expect(chord?.modifiers.ctrlKey).toBe(true)
  })

  it.each(Array.from({ length: 24 }, (_, i) => 'f' + (i + 1)))('accepts %s alone', (key) => {
    expect(parseChord(key, { ...keys, [key]: 1000 }, 'win32')?.modifiers).toEqual({
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    })
  })

  it.each([
    '',
    'space',
    'enter',
    'a',
    'ctrl',
    'shift',
    'alt',
    'alt-right',
    'ctrl-left',
    'option-right',
    'meta-right',
    'ctrl+CtrlRight',
    'ctrl+unknown',
    'ctrl+space+a',
    'ctrl++space',
    'ctrl+ctrl+space',
    'ctrl+escape',
    'ctrl+esc',
    'ctrl+tab',
    'ctrl+arrowleft',
    'ctrl+delete',
    'ctrl+f0',
    'f25',
    'f01',
    'Ctrl+space',
    ' ctrl+space',
    'ctrl+ space',
    'option+space',
    'commandorcontrol+f8',
    'alt+ctrl+space',
    'meta+shift+space',
    'space+ctrl',
  ])('refuses old aliases and invalid formats: %s', (shortcut) => {
    expect(shortcutError(shortcut, 'win32')).toBeTypeOf('string')
    expect(parseChord(shortcut, keys, 'win32')).toBeNull()
  })

  it.each([
    ['alt+tab', 'win32'],
    ['alt+f4', 'linux'],
    ['ctrl+alt+delete', 'win32'],
    ['meta+l', 'win32'],
    ['meta+d', 'linux'],
    ['meta+tab', 'win32'],
    ['meta', 'win32'],
    ['meta+q', 'darwin'],
    ['meta+tab', 'darwin'],
    ['meta+space', 'darwin'],
    ['ctrl+space', 'darwin'],
  ])('explains why %s is reserved on %s', (shortcut, platform) => {
    expect(shortcutError(shortcut!, platform!)).toContain('reserved')
    expect(parseChord(shortcut!, keys, platform!)).toBeNull()
  })

  it('preserves still-valid legacy values and refuses removed modifier-only shortcuts', () => {
    for (const shortcut of ['ctrl+space', 'alt+space', 'ctrl+alt+space'])
      expect(parseChord(shortcut, keys, 'win32')).not.toBeNull()
    expect(parseChord('alt+space', keys, 'darwin')).not.toBeNull()
    expect(parseChord('ctrl+space', keys, 'darwin')).toBeNull()
    expect(parseChord('alt-right', keys, 'darwin')).toBeNull()
  })

  it('does not arm a key absent from the native key table', () => {
    expect(parseChord('ctrl+quote', keys, 'win32')).toBeNull()
  })

  it('requires canonical modifier order on macOS without a default exception', () => {
    expect(parseChord('meta+shift+space', keys, 'darwin')).toBeNull()
    expect(shortcutError('meta+shift+space', 'darwin')).toContain('ctrl, alt, shift, meta')
    expect(parseChord('shift+meta+space', keys, 'darwin')).not.toBeNull()
  })
})

describe('speech chord matching', () => {
  it('requires exact modifiers, ignores repeats and releases either modifier side', () => {
    const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
    expect(tracker.down(event(keys.Space))).toBeNull()
    expect(tracker.down(event(keys.Space, { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBe('down')
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBeNull()
    expect(tracker.up(event(keys.A, { ctrlKey: true }))).toBeNull()
    expect(tracker.up(event(keys.CtrlRight))).toBe('up')
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBeNull()
    tracker.up(event(keys.Space))
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBe('down')
    expect(tracker.up(event(keys.Space))).toBe('up')
  })

  it('supports a function key alone without matching a modified function key', () => {
    const tracker = new ChordTracker(parseChord('f8', keys, 'win32')!, keys.Escape)
    expect(tracker.down(event(keys.F8, { ctrlKey: true }))).toBeNull()
    expect(tracker.down(event(keys.F8))).toBe('down')
    expect(tracker.down(event(keys.F8))).toBeNull()
    expect(tracker.up(event(keys.F8))).toBe('up')
  })

  it('cancels with Escape without restarting a repeat before release', () => {
    const tracker = new ChordTracker(parseChord('alt+space', keys, 'darwin')!, keys.Escape)
    expect(tracker.down(event(keys.Space, { altKey: true }))).toBe('down')
    expect(tracker.down(event(keys.Escape))).toBe('cancel')
    expect(tracker.down(event(keys.Space, { altKey: true }))).toBeNull()
    expect(tracker.up(event(keys.Space))).toBe('up')
    expect(tracker.down(event(keys.Space, { altKey: true }))).toBe('down')
  })

  it('tracks injected modifiers with false flags and retains either pressed side', () => {
    const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
    tracker.down(event(keys.Ctrl))
    tracker.down(event(keys.CtrlRight))
    expect(tracker.down(event(keys.Space))).toBe('down')
    expect(tracker.up(event(keys.A))).toBeNull()
    expect(tracker.up(event(keys.Ctrl))).toBeNull()
    expect(tracker.up(event(keys.CtrlRight))).toBe('up')
  })

  it('clears Ctrl or Shift whose release was missed when authoritative flags report it up', () => {
    const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
    tracker.down(event(keys.Ctrl, { ctrlKey: true }))
    expect(tracker.down(event(keys.Space))).toBeNull()
    tracker.down(event(keys.Shift, { shiftKey: true }))
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBe('down')
    tracker.up(event(keys.Space))
    expect(tracker.down(event(keys.Space))).toBeNull()
    tracker.down(event(keys.Ctrl))
    expect(tracker.down(event(keys.Space))).toBeNull()
  })

  it('learns flag authority separately for each modifier', () => {
    const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
    tracker.down(event(keys.Alt, { altKey: true }))
    tracker.up(event(keys.Alt))
    tracker.down(event(keys.Ctrl))
    expect(tracker.down(event(keys.Space))).toBe('down')
  })

  it.each(['down', 'up'] as const)(
    'recovers a missed modifier release on a later %s event',
    (kind) => {
      const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
      tracker.down(event(keys.Ctrl, { ctrlKey: true }))
      expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBe('down')
      expect(tracker[kind](event(keys.A))).toBe('up')
      expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBeNull()
    },
  )

  it('keeps a press ignored during transcription blocked until its key-up', () => {
    const tracker = new ChordTracker(parseChord('f8', keys, 'win32')!, keys.Escape)
    expect(tracker.down(event(keys.F8), 0, false)).toBeNull()
    expect(tracker.down(event(keys.A), 10, false)).toBeNull()
    expect(tracker.down(event(keys.Escape), 20, false)).toBeNull()
    expect(tracker.down(event(keys.F8), 2000)).toBeNull()
    tracker.up(event(keys.F8))
    expect(tracker.down(event(keys.F8), 2001)).toBe('down')
  })

  it('waits for a key-up or a full second without shortcut-key downs after reset', () => {
    const tracker = new ChordTracker(parseChord('f8', keys, 'win32')!, keys.Escape)
    tracker.down(event(keys.F8), 0)
    tracker.reset(100)
    expect(tracker.down(event(keys.F8), 1099)).toBeNull()
    tracker.down(event(keys.A), 1500)
    expect(tracker.down(event(keys.F8), 2098)).toBeNull()
    expect(tracker.down(event(keys.F8), 3098)).toBe('down')
    tracker.reset(4000)
    expect(tracker.down(event(keys.F8), 4999)).toBeNull()
    tracker.up(event(keys.F8))
    expect(tracker.down(event(keys.F8), 5000)).toBe('down')
  })

  it('requires the quiet second even when no primary press was seen before reset', () => {
    const tracker = new ChordTracker(parseChord('f8', keys, 'win32')!, keys.Escape)
    tracker.reset(0)
    expect(tracker.down(event(keys.F8), 999)).toBeNull()
    expect(tracker.down(event(keys.F8), 1999)).toBe('down')
  })
})
