import { afterEach, expect, it } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import { applyAppearance, applyCachedAppearance, cacheAppearance } from './appearance'

afterEach(() => {
  localStorage.removeItem('ari.appearance')
  applyAppearance(defaultSettings.appearance)
})

it('restores cached font and scale before hydration, and lets themes own their default font', () => {
  cacheAppearance({
    ...defaultSettings.appearance,
    fontFamily: 'mono',
    fontSize: 18,
    chatWidth: 'wide',
    chatStyle: 'terminal',
  })
  applyCachedAppearance()
  const root = document.documentElement
  expect(root.style.fontSize).toBe('18px')
  expect(root.style.getPropertyValue('--ari-font-ui')).toBe('var(--ari-font-mono)')
  expect(root.dataset['ariChatWidth']).toBe('wide')
  expect(root.dataset['ariChatStyle']).toBe('terminal')
  applyAppearance(defaultSettings.appearance)
  expect(root.style.getPropertyValue('--ari-font-ui')).toBe('')
})

it('falls back to defaults for a malformed cache rather than applying invalid CSS', () => {
  localStorage.setItem('ari.appearance', JSON.stringify({ fontSize: 200, fontFamily: 'missing' }))
  applyCachedAppearance()
  expect(document.documentElement.style.fontSize).toBe('16px')
  expect(document.documentElement.dataset['ariChatStyle']).toBe('conversation')
})
