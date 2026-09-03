import { describe, expect, it } from 'vitest'
import { isAppUrl, isExternalOpenable } from './external-links'

describe('isExternalOpenable', () => {
  it('allows http, https, and mailto', () => {
    expect(isExternalOpenable('http://localhost:3000')).toBe(true)
    expect(isExternalOpenable('https://example.com/x')).toBe(true)
    expect(isExternalOpenable('mailto:hi@example.com')).toBe(true)
  })

  it('refuses file, javascript, data, and custom schemes', () => {
    expect(isExternalOpenable('file:///etc/passwd')).toBe(false)
    expect(isExternalOpenable('javascript:alert(1)')).toBe(false)
    expect(isExternalOpenable('data:text/html,hi')).toBe(false)
    expect(isExternalOpenable('vscode://file/x')).toBe(false)
    expect(isExternalOpenable('not a url')).toBe(false)
  })
})

describe('isAppUrl', () => {
  it('keeps the packaged file renderer and internal navigations inside', () => {
    expect(isAppUrl('file:///app/renderer/index.html')).toBe(true)
    expect(isAppUrl('about:blank')).toBe(true)
  })

  it('keeps the Vite dev-server origin inside', () => {
    expect(isAppUrl('http://localhost:5173/', 'http://localhost:5173/')).toBe(true)
    expect(isAppUrl('http://localhost:3000/', 'http://localhost:5173/')).toBe(false)
  })

  it('treats agent-produced localhost links as external', () => {
    expect(isAppUrl('http://localhost:3000')).toBe(false)
  })
})
