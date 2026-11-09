import { expect, it } from 'vitest'
import { defaultSettings, settingsSchema, settingsUpdateSchema } from './settings'
import { rpcParams } from './rpc'

it('migrates settings without a configured speech model', () => {
  const { speech: _speech, ...legacy } = defaultSettings
  expect(settingsSchema.parse(legacy).speech).toEqual({
    enabled: false,
    modelId: null,
    modelPath: null,
    shortcut: '',
  })
})
it('keeps speech patches default-free and validates PCM bounds', () => {
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
