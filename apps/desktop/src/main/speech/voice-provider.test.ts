// @vitest-environment node
import { expect, it } from 'vitest'
import { fasterVoiceProvider } from './voice-provider'
it('uses acceleration only when the measured gain exceeds noise', () => {
  expect(fasterVoiceProvider(1000, 500)).toBe(true)
  expect(fasterVoiceProvider(1000, 950)).toBe(false)
  expect(fasterVoiceProvider(1000, 1200)).toBe(false)
  expect(fasterVoiceProvider(1000, NaN)).toBe(false)
})
