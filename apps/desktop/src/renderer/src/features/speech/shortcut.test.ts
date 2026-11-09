// @vitest-environment node
import { expect, it } from 'vitest'
import { ModifierShortcutCapture } from './shortcut'

const key = (code: string, flags: Partial<KeyboardEvent> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  timeStamp: 100,
  getModifierState: () => false,
  ...flags,
})

it('captures Windows AltGr without its synthetic left Ctrl', () => {
  const capture = new ModifierShortcutCapture()
  capture.press(key('ControlLeft', { ctrlKey: true }), true)
  capture.press(
    key('AltRight', {
      ctrlKey: true,
      altKey: true,
      timeStamp: 130,
    }),
    true,
  )
  expect(capture.release(key('AltRight', { ctrlKey: true }))).toBe('alt-right')
  expect(capture.release(key('ControlLeft'))).toBeNull()
})

it('captures Linux Right Alt through AltGraph when altKey is false', () => {
  const capture = new ModifierShortcutCapture()
  capture.press(key('AltRight', { getModifierState: (name) => name === 'AltGraph' }), false)
  expect(capture.release(key('AltRight'))).toBe('alt-right')
})

it('requires the synthetic Windows Ctrl and Right Alt to be consecutive key events', () => {
  const capture = new ModifierShortcutCapture()
  capture.press(key('ControlLeft', { ctrlKey: true }), true)
  capture.press(key('KeyA', { ctrlKey: true, timeStamp: 110 }), true)
  capture.press(key('AltRight', { ctrlKey: true, altKey: true, timeStamp: 130 }), true)
  expect(capture.release(key('AltRight', { ctrlKey: true }))).toBeNull()
  capture.reset()
  capture.press(key('ControlLeft', { ctrlKey: true }), true)
  capture.release(key('KeyA', { ctrlKey: true, timeStamp: 110 }))
  capture.press(key('AltRight', { ctrlKey: true, altKey: true, timeStamp: 130 }), true)
  expect(capture.release(key('AltRight', { ctrlKey: true }))).toBeNull()
})

it('does not mistake a physical Ctrl held before AltGr for synthetic Ctrl', () => {
  const capture = new ModifierShortcutCapture()
  capture.press(key('ControlLeft', { ctrlKey: true, timeStamp: 1 }), true)
  capture.press(
    key('AltRight', { ctrlKey: true, altKey: true, timeStamp: 100, getModifierState: () => true }),
    true,
  )
  expect(capture.release(key('AltRight', { ctrlKey: true }))).toBeNull()
})

it('rejects both physical sides of the same modifier and unseen held modifiers', () => {
  const capture = new ModifierShortcutCapture()
  capture.press(key('ControlLeft', { ctrlKey: true }), false)
  capture.press(key('ControlRight', { ctrlKey: true }), false)
  expect(capture.release(key('ControlRight', { ctrlKey: true }))).toBeNull()
  expect(capture.release(key('ControlLeft'))).toBeNull()
  capture.press(key('AltRight', { altKey: true }), false)
  expect(capture.release(key('AltRight', { altKey: true }))).toBeNull()
})

it('requires the matching modifier flag and clears captured keys on blur', () => {
  const capture = new ModifierShortcutCapture()
  capture.press(key('ControlRight'), false)
  expect(capture.release(key('ControlRight'))).toBeNull()
  capture.press(key('AltRight', { altKey: true }), false)
  capture.reset()
  expect(capture.release(key('AltRight'))).toBeNull()
})
