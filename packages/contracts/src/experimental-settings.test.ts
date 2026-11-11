import { expect, it } from 'vitest'
import { defaultSettings, settingsSchema, settingsUpdateSchema } from './settings'

it('defaults Aria off for new and existing installs', () => {
  expect(defaultSettings.experimental.ariaEnabled).toBe(false)
  expect(settingsSchema.parse({ version: 1 }).experimental.ariaEnabled).toBe(false)
  expect(settingsSchema.parse({ version: 1, experimental: {} }).experimental.ariaEnabled).toBe(
    false,
  )
})

it('accepts an explicit experiment patch without changing unrelated settings', () => {
  expect(settingsUpdateSchema.parse({ experimental: { ariaEnabled: true } })).toEqual({
    experimental: { ariaEnabled: true },
  })
  expect(settingsUpdateSchema.parse({ experimental: {} })).toEqual({ experimental: {} })
  expect(settingsUpdateSchema.safeParse({ experimental: { ariaEnabled: 'true' } }).success).toBe(
    false,
  )
})
