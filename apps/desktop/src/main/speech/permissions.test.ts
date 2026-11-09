// @vitest-environment node
import { expect, it } from 'vitest'
import { isSpeechPage } from './permissions'

it('grants speech only to Ari pages and its configured development origin', () => {
  expect(isSpeechPage('https://example.com/index.html', '')).toBe(false)
  expect(isSpeechPage('file:///C:/Downloads/other.html', '')).toBe(false)
  expect(isSpeechPage('http://localhost:5173/index.html', 'http://localhost:5173')).toBe(true)
  expect(isSpeechPage('http://localhost:5174/index.html', 'http://localhost:5173')).toBe(false)
  expect(isSpeechPage('not a URL', '')).toBe(false)
})
