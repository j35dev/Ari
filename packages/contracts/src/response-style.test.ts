import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  responseStyleSchema,
  settingsSchema,
  settingsUpdateSchema,
} from './settings'

describe('response style settings contract', () => {
  it('keeps the existing Ari presentation on first boot and legacy settings', () => {
    expect(defaultSettings.appearance.responseStyle).toBe('default')
    expect(settingsSchema.parse({ version: 1 }).appearance.responseStyle).toBe('default')
    const stored = settingsSchema.parse({
      version: 1,
      appearance: {
        themeId: 'nocturne',
        mode: 'nocturne',
        reducedMotion: true,
        wallpaper: 'stillwater',
      },
    })
    expect(stored.appearance).toMatchObject({
      responseStyle: 'default',
      themeId: 'nocturne',
      mode: 'nocturne',
      reducedMotion: true,
      wallpaper: 'stillwater',
    })
  })

  it.each(responseStyleSchema.options)(
    'round-trips the %s style through storage and patches',
    (responseStyle) => {
      expect(
        settingsSchema.parse({ version: 1, appearance: { responseStyle } }).appearance
          .responseStyle,
      ).toBe(responseStyle)
      expect(settingsUpdateSchema.parse({ appearance: { responseStyle } })).toEqual({
        appearance: { responseStyle },
      })
    },
  )

  it.each(['trace', 'future-layout', '', null, 4, {}])(
    'falls back on an unknown stored style without resetting other preferences: %j',
    (responseStyle) => {
      const stored = settingsSchema.parse({
        version: 1,
        appearance: { responseStyle, themeId: 'verdant', mode: 'verdant', reducedMotion: true },
      })
      expect(stored.appearance).toMatchObject({
        responseStyle: 'default',
        themeId: 'verdant',
        mode: 'verdant',
        reducedMotion: true,
      })
      expect(settingsUpdateSchema.safeParse({ appearance: { responseStyle } }).success).toBe(false)
    },
  )

  it('never injects a response style into an unrelated partial update', () => {
    expect(settingsUpdateSchema.parse({ appearance: { reducedMotion: true } })).toEqual({
      appearance: { reducedMotion: true },
    })
    expect(settingsUpdateSchema.parse({ appearance: {} })).toEqual({ appearance: {} })
  })
})
