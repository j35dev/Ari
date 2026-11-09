import { expect, it } from 'vitest'
import {
  defaultSettings,
  settingsSchema,
  settingsUpdateSchema,
  defaultSpeechShortcut,
  speechShortcutError,
  migrateSpeechShortcut,
} from './settings'
import { rpcParams } from './rpc'

it('migrates settings without a configured speech model', () => {
  const { speech: _speech, ...legacy } = defaultSettings
  expect(settingsSchema.parse(legacy).speech).toEqual({
    enabled: false,
    modelId: null,
    modelPath: null,
    shortcut: '',
    duckAudio: true,
  })
})
it('keeps speech patches default-free and validates PCM bounds', () => {
  expect(settingsUpdateSchema.parse({ speech: { duckAudio: false } }).speech).toEqual({
    duckAudio: false,
  })
  expect(settingsUpdateSchema.parse({ speech: { shortcut: 'ctrl+space' } }).speech).toEqual({
    shortcut: 'ctrl+space',
  })
  expect(rpcParams['speech.transcribe'].safeParse({ pcm: new Float32Array([0.1]) }).success).toBe(
    true,
  )
  expect(rpcParams['speech.transcribe'].safeParse({ pcm: [NaN] }).success).toBe(false)
  expect(rpcParams['speech.select'].safeParse({}).success).toBe(false)
  expect(rpcParams['speech.select'].safeParse({ modelId: 'one', path: '/two' }).success).toBe(false)
})

it.each(['win32', 'linux', 'darwin'])('migrates old speech shortcuts on %s', (platform) => {
  for (const chord of ['alt+space', 'ctrl+alt+space'])
    expect(migrateSpeechShortcut(chord, platform)).toBe(chord)
  expect(migrateSpeechShortcut('ctrl+space', platform)).toBe(
    platform === 'darwin' ? defaultSpeechShortcut(platform) : 'ctrl+space',
  )
  for (const chord of ['', 'alt-right', 'ctrl-left', 'alt', 'meta', 'ctrl+tab', 'alt+f4'])
    expect(migrateSpeechShortcut(chord, platform)).toBe(defaultSpeechShortcut(platform))
  expect(speechShortcutError(defaultSpeechShortcut(platform), platform)).toBeNull()
})

it('uses the coordinated platform defaults', () => {
  expect(defaultSpeechShortcut('win32')).toBe('ctrl+alt+space')
  expect(defaultSpeechShortcut('linux')).toBe('ctrl+alt+space')
  expect(defaultSpeechShortcut('darwin')).toBe('shift+meta+space')
})

it('enforces ctrl, alt, shift, meta ordering and migrates shortcuts with reversed modifiers', () => {
  for (const chord of [
    'ctrl+alt+space',
    'ctrl+shift+d',
    'shift+meta+space',
    'ctrl+alt+shift+meta+enter',
  ]) {
    expect(speechShortcutError(chord, 'darwin')).toBeNull()
    expect(settingsUpdateSchema.safeParse({ speech: { shortcut: chord } }).success).toBe(true)
  }
  for (const chord of [
    'alt+ctrl+space',
    'meta+shift+space',
    'ctrl+meta+shift+d',
    'shift+alt+comma',
  ]) {
    expect(speechShortcutError(chord, 'darwin')).toContain('order')
    expect(settingsUpdateSchema.safeParse({ speech: { shortcut: chord } }).success).toBe(false)
    expect(migrateSpeechShortcut(chord, 'darwin')).toBe('shift+meta+space')
  }
})

it.each([
  'space',
  'a',
  'z',
  '0',
  '9',
  'enter',
  'f1',
  'f24',
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
])('accepts the shared key name %s', (key) => {
  expect(speechShortcutError(`ctrl+${key}`, 'win32')).toBeNull()
  expect(settingsUpdateSchema.safeParse({ speech: { shortcut: `ctrl+${key}` } }).success).toBe(true)
})

it('requires canonical lowercase chords and a modifier, except for function keys alone', () => {
  for (const chord of [
    'a',
    'space',
    'enter',
    'Ctrl+space',
    ' ctrl+space',
    'ctrl+space ',
    'ctrl+ctrl+a',
    'a+ctrl',
    'ctrl++a',
    'ctrl+f0',
    'ctrl+f25',
    'ctrl+tab',
    'alt-right',
  ]) {
    expect(speechShortcutError(chord, 'win32')).not.toBeNull()
    expect(settingsUpdateSchema.safeParse({ speech: { shortcut: chord } }).success).toBe(false)
  }
  expect(speechShortcutError('f1', 'win32')).toBeNull()
  expect(speechShortcutError('f24', 'darwin')).toBeNull()
})

it.each([
  ['win32', 'alt+tab'],
  ['win32', 'alt+f4'],
  ['win32', 'ctrl+alt+delete'],
  ['win32', 'meta+l'],
  ['win32', 'meta+d'],
  ['win32', 'meta+tab'],
  ['win32', 'meta'],
  ['linux', 'meta+l'],
  ['darwin', 'meta+q'],
  ['darwin', 'meta+tab'],
  ['darwin', 'meta+space'],
  ['darwin', 'ctrl+space'],
])('explains reserved %s shortcut %s', (platform, chord) => {
  expect(speechShortcutError(chord, platform)).toContain('reserved')
})
