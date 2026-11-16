import { expect, it } from 'vitest'
import {
  defaultSettings,
  defaultSnapshotShortcut,
  settingsSchema,
  settingsUpdateSchema,
  snapshotShortcutError,
} from './settings'

it('migrates old preferences with SnapShots off', () => {
  const { snapshots: _snapshots, ...legacy } = defaultSettings
  expect(settingsSchema.parse(legacy).snapshots).toEqual({
    enabled: false,
    shortcut: '',
    animation: true,
    sound: true,
  })
})
it('does not populate defaults in a SnapShots patch', () => {
  expect(settingsUpdateSchema.parse({ snapshots: { sound: false } }).snapshots).toEqual({
    sound: false,
  })
  expect(settingsUpdateSchema.safeParse({ snapshots: { shortcut: 'a'.repeat(81) } }).success).toBe(
    false,
  )
  expect(settingsUpdateSchema.safeParse({ snapshots: { enabled: 'yes' } }).success).toBe(false)
})
it.each(['win32', 'darwin'])('uses a valid default on %s', (platform) => {
  expect(snapshotShortcutError(defaultSnapshotShortcut(platform), platform)).toBeNull()
})
it.each([
  'ctrl+k',
  'ctrl+n',
  'ctrl+shift+s',
  'ctrl+alt+1',
  'ctrl+enter',
  'ctrl+backquote',
  'ctrl+alt+t',
  'ctrl+alt+w',
  'ctrl+shift+f',
  'ctrl+b',
  'ctrl+backslash',
])('reserves Ari command %s', (chord) => {
  expect(snapshotShortcutError(chord, 'win32')).toContain('Ari')
})
it.each([
  'alt+tab',
  'alt+f4',
  'ctrl+alt+delete',
  'meta+l',
  'meta+d',
  'ctrl+c',
  'shift+p',
  'shift+shift',
  'p',
  'Ctrl+Alt+P',
  'alt+ctrl+p',
  'ctrl+ctrl+p',
])('refuses unsafe or malformed chord %s', (chord) => {
  expect(snapshotShortcutError(chord, 'win32')).toBeTruthy()
})
it('reserves custom dictation shortcuts even when dictation is off', () => {
  expect(
    snapshotShortcutError('ctrl+alt+p', 'win32', {
      shortcut: 'ctrl+alt+p',
      dictationShortcut: 'ctrl+alt+d',
    }),
  ).toContain('dictation')
  expect(
    snapshotShortcutError('f12', 'win32', { shortcut: 'ctrl+alt+p', dictationShortcut: 'f12' }),
  ).toContain('dictation')
})
