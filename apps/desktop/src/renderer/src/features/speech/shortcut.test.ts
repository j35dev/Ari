// @vitest-environment node
import { expect, it } from 'vitest'
import { shortcutFromKey } from './shortcut'

const key = (code: string, flags: Partial<KeyboardEvent> = {}) => ({
  code,
  key: code,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...flags,
})

it('records function keys alone and keys with modifiers', () => {
  expect(shortcutFromKey(key('F8'), 'win32')).toEqual({ shortcut: 'f8' })
  expect(shortcutFromKey(key('KeyD', { ctrlKey: true, shiftKey: true }), 'linux')).toEqual({
    shortcut: 'ctrl+shift+d',
  })
  expect(
    shortcutFromKey(key('Digit1', { key: '!', altKey: true, shiftKey: true }), 'win32'),
  ).toEqual({ shortcut: 'alt+shift+1' })
  expect(
    shortcutFromKey(
      key('Enter', { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }),
      'darwin',
    ),
  ).toEqual({ shortcut: 'ctrl+alt+shift+meta+enter' })
})

it.each([
  ['Comma', 'comma'],
  ['Period', 'period'],
  ['Slash', 'slash'],
  ['Semicolon', 'semicolon'],
  ['Quote', 'quote'],
  ['Backquote', 'backquote'],
  ['Minus', 'minus'],
  ['Equal', 'equal'],
  ['BracketLeft', 'bracketleft'],
  ['BracketRight', 'bracketright'],
  ['Backslash', 'backslash'],
])('uses the uiohook name for %s regardless of shifted text', (code, name) => {
  expect(shortcutFromKey(key(code, { key: ':', ctrlKey: true, shiftKey: true }), 'win32')).toEqual({
    shortcut: `ctrl+shift+${name}`,
  })
})

it('waits for a key after a modifier and rejects unsupported keys and unmodified letters', () => {
  expect(shortcutFromKey(key('ControlLeft', { key: 'Control', ctrlKey: true }), 'win32')).toBeNull()
  expect(shortcutFromKey(key('AltRight', { key: 'AltGraph', altKey: true }), 'linux')).toBeNull()
  expect(shortcutFromKey(key('KeyA'), 'win32')).toHaveProperty('error')
  expect(shortcutFromKey(key('Numpad0', { ctrlKey: true }), 'win32')).toHaveProperty('error')
  expect(shortcutFromKey(key('Tab', { ctrlKey: true }), 'win32')).toHaveProperty('error')
})

it('refuses reserved combinations before saving them', () => {
  expect(shortcutFromKey(key('F4', { altKey: true }), 'win32')).toEqual({
    error: expect.stringContaining('reserved'),
  })
  expect(shortcutFromKey(key('Space', { ctrlKey: true }), 'darwin')).toEqual({
    error: expect.stringContaining('reserved'),
  })
  expect(shortcutFromKey(key('Delete', { ctrlKey: true, altKey: true }), 'win32')).toEqual({
    error: expect.stringContaining('reserved'),
  })
})
