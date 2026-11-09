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
    expect(defaultShortcut('darwin')).toBe('alt-right')
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
    'alt+alt-right',
    'alt-right+space',
    'option-unknown',
  ])('does not arm malformed or ambiguous settings: %s', (shortcut) => {
    expect(parseChord(shortcut, keys, 'win32')).toBeNull()
  })

  it('requires the exact modifiers, ignores repeats and releases either side of a modifier', () => {
    const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
    expect(tracker.down(event(keys.Space))).toBeNull()
    expect(tracker.down(event(keys.Space, { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBe('down')
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBeNull()
    expect(tracker.up(event(keys.A, { ctrlKey: true }))).toBeNull()
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

  it('tracks injected modifiers even with false flags and retains either pressed side', () => {
    const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
    tracker.down(event(keys.Ctrl))
    tracker.down(event(keys.CtrlRight))
    expect(tracker.down(event(keys.Space))).toBe('down')
    expect(tracker.down(event(keys.Space))).toBeNull()
    expect(tracker.up(event(keys.A))).toBeNull()
    expect(tracker.up(event(keys.Ctrl))).toBeNull()
    expect(tracker.up(event(keys.CtrlRight))).toBe('up')
    expect(tracker.down(event(keys.Space))).toBeNull()
  })

  it('clears a Ctrl or Shift key whose release was missed when flags report it up', () => {
    const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
    tracker.down(event(keys.Ctrl, { ctrlKey: true }))
    expect(tracker.down(event(keys.Space))).toBeNull()
    tracker.down(event(keys.Shift, { shiftKey: true }))
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBe('down')
    tracker.up(event(keys.Space))
    expect(tracker.down(event(keys.Space))).toBeNull()
    expect(tracker.down(event(keys.Space))).toBeNull()
    tracker.reset()
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

  it.each(['left', 'right'])('accepts side-specific aliases on the %s', (side) => {
    for (const [name, canonical] of [
      ['option', 'alt'],
      ['cmd', 'meta'],
      ['command', 'meta'],
      ['control', 'ctrl'],
      ['super', 'meta'],
    ]) {
      expect(parseChord(`${name}-${side}`, keys, 'darwin')).toEqual(
        parseChord(`${canonical}-${side}`, keys, 'darwin'),
      )
    }
  })

  it.each([false, true])('ignores AltGr synthetic left Ctrl with its flag set to %s', (ctrlKey) => {
    const tracker = new ChordTracker(parseChord('alt-right', keys, 'win32')!, keys.Escape)
    tracker.down(event(keys.Ctrl, { ctrlKey, time: 10 }), 10)
    expect(tracker.down(event(keys.AltRight, { ctrlKey, altKey: true, time: 35 }), 35)).toBe('down')
    expect(tracker.down(event(keys.A, { ctrlKey, altKey: true, time: 11 }))).toBe('cancel')
    tracker.up(event(keys.AltRight))
    tracker.up(event(keys.Ctrl))
  })

  it('retains deliberately held Ctrl when it is not the AltGr synthetic event', () => {
    const tracker = new ChordTracker(parseChord('alt-right', keys, 'win32')!, keys.Escape)
    tracker.down(event(keys.Ctrl, { ctrlKey: true, time: 10 }), 10)
    expect(
      tracker.down(event(keys.AltRight, { ctrlKey: true, altKey: true, time: 100 }), 100),
    ).toBeNull()
    const ctrlChord = new ChordTracker(parseChord('ctrl+alt-right', keys, 'win32')!, keys.Escape)
    ctrlChord.down(event(keys.Ctrl, { ctrlKey: true, time: 10 }), 10)
    expect(
      ctrlChord.down(event(keys.AltRight, { ctrlKey: true, altKey: true, time: 35 }), 35),
    ).toBe('down')
  })

  it.each(['key-up', 'key-down', 'mouse'] as const)(
    'requires the AltGr pair to be consecutive without an intervening %s',
    (kind) => {
      const tracker = new ChordTracker(parseChord('alt-right', keys, 'win32')!, keys.Escape)
      tracker.down(event(keys.Ctrl, { ctrlKey: true }), 0)
      if (kind === 'key-up') tracker.up(event(keys.A, { ctrlKey: true }))
      else if (kind === 'key-down') tracker.down(event(keys.A, { ctrlKey: true }), 10)
      else tracker.mouseMove()
      expect(tracker.down(event(keys.AltRight, { ctrlKey: true, altKey: true }), 25)).toBeNull()
    },
  )

  it('suppresses only closely spaced primary repeats after reset and accepts a hold without key-up', () => {
    const tracker = new ChordTracker(parseChord('alt-right', keys, 'darwin')!, keys.Escape)
    expect(tracker.down(event(keys.AltRight, { altKey: true }), 0)).toBe('down')
    tracker.reset()
    expect(tracker.down(event(keys.AltRight, { altKey: true }), 120)).toBeNull()
    expect(tracker.down(event(keys.AltRight, { altKey: true }), 241)).toBe('down')
  })

  it('does not latch a press that was ignored while another dictation was finishing', () => {
    const tracker = new ChordTracker(parseChord('alt-right', keys, 'darwin')!, keys.Escape)
    expect(tracker.down(event(keys.AltRight, { altKey: true }), 0, false)).toBeNull()
    expect(tracker.down(event(keys.A, { altKey: true }), 10, false)).toBeNull()
    expect(tracker.down(event(keys.Escape, { altKey: true }), 20, false)).toBeNull()
    expect(tracker.mouseDown(1)).toBe(false)
    tracker.mouseUp(1)
    expect(tracker.down(event(keys.AltRight, { altKey: true }), 250)).toBeNull()
    tracker.up(event(keys.AltRight))
    tracker.up(event(keys.A))
    tracker.up(event(keys.Escape))
    expect(tracker.down(event(keys.AltRight, { altKey: true }), 300)).toBe('down')
  })

  it('rejects a modifier hold while another key or a mouse button is already down', () => {
    const tracker = new ChordTracker(parseChord('alt-right', keys, 'darwin')!, keys.Escape)
    tracker.down(event(keys.A), 0)
    expect(tracker.down(event(keys.AltRight, { altKey: true }), 10)).toBeNull()
    tracker.up(event(keys.AltRight))
    tracker.up(event(keys.A))
    tracker.mouseDown(1)
    expect(tracker.down(event(keys.AltRight, { altKey: true }), 20)).toBeNull()
    tracker.mouseUp(1)
    tracker.up(event(keys.AltRight))
    expect(tracker.down(event(keys.AltRight, { altKey: true }), 30)).toBe('down')
    expect(tracker.mouseMove()).toBe(false)
    expect(tracker.mouseDown(1)).toBe(true)
    expect(tracker.mouseMove()).toBe(true)
    tracker.mouseUp(1)
  })

  it.each(['down', 'up'] as const)(
    'recovers a missed modifier release on a later %s event',
    (kind) => {
      const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
      tracker.down(event(keys.Ctrl, { ctrlKey: true }))
      expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBe('down')
      expect(tracker[kind](event(keys.A))).toBe('up')
      expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBeNull()
      tracker.up(event(keys.Space))
      tracker.up(event(keys.Ctrl))
      expect(tracker.down(event(keys.Space))).toBeNull()
    },
  )

  it('reset discards a hold and blocks repeats until the primary has been released', () => {
    const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
    tracker.down({ keycode: keys.Ctrl })
    tracker.down({ keycode: keys.Space })
    tracker.reset()
    expect(tracker.down({ keycode: keys.Space })).toBeNull()
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBeNull()
    tracker.reset()
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBeNull()
    tracker.up(event(keys.Space))
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBe('down')
  })

  it('clears unmatched primary presses across lock then suspend without swallowing a fresh hold', () => {
    const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
    expect(tracker.down(event(keys.Space), 0)).toBeNull()
    tracker.reset()
    tracker.reset()
    expect(tracker.down(event(keys.Space, { ctrlKey: true }), 121)).toBe('down')
  })

  it('keeps repeat suppression through consecutive resets until the held key is released', () => {
    const tracker = new ChordTracker(parseChord('ctrl+space', keys, 'win32')!, keys.Escape)
    tracker.down(event(keys.Space, { ctrlKey: true }))
    tracker.reset()
    tracker.reset()
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBeNull()
    tracker.up(event(keys.Space))
    expect(tracker.down(event(keys.Space, { ctrlKey: true }))).toBe('down')
  })

  it('silently cancels a modifier-only hold when a character key is pressed', () => {
    const tracker = new ChordTracker(parseChord('alt-right', keys, 'darwin')!, keys.Escape)
    expect(tracker.down(event(keys.AltRight, { altKey: true }))).toBe('down')
    expect(tracker.down(event(keys.A, { altKey: true }))).toBe('cancel')
    expect(tracker.down(event(keys.AltRight, { altKey: true }))).toBeNull()
    expect(tracker.up(event(keys.AltRight))).toBe('up')
  })

  it('holds Right Option alone without accepting Left Option or other modifiers', () => {
    const chord = parseChord(defaultShortcut('darwin'), keys, 'darwin')!
    expect(chord.keycode).toBe(keys.AltRight)
    const tracker = new ChordTracker(chord, keys.Escape)
    expect(tracker.down(event(keys.Alt, { altKey: true }))).toBeNull()
    tracker.up(event(keys.Alt))
    expect(tracker.down(event(keys.AltRight, { altKey: true, ctrlKey: true }))).toBeNull()
    tracker.up(event(keys.AltRight))
    expect(tracker.down(event(keys.AltRight, { altKey: true }))).toBe('down')
    expect(tracker.down(event(keys.AltRight, { altKey: true }))).toBeNull()
    tracker.down(event(keys.Alt, { altKey: true }))
    expect(tracker.up(event(keys.Alt, { altKey: true }))).toBeNull()
    expect(tracker.up(event(keys.AltRight))).toBe('up')
    expect(tracker.down(event(keys.AltRight, { altKey: true }))).toBe('down')
    tracker.reset()
    expect(tracker.down(event(keys.AltRight, { altKey: true }))).toBeNull()
    tracker.up(event(keys.AltRight))
    expect(tracker.down(event(keys.AltRight, { altKey: true }))).toBe('down')
  })
})
