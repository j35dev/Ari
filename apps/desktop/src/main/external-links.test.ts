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
  const entry = 'file:///app/renderer/index.html'

  it('keeps the packaged renderer entry and internal navigations inside', () => {
    expect(isAppUrl(entry, undefined, entry)).toBe(true)
    // SPA hash routes on the same entry file stay.
    expect(isAppUrl(`${entry}#/settings`, undefined, entry)).toBe(true)
    expect(isAppUrl('about:blank')).toBe(true)
  })

  it('refuses arbitrary file URLs even when the entry is known', () => {
    expect(isAppUrl('file:///etc/passwd', undefined, entry)).toBe(false)
    expect(isAppUrl('file:///app/renderer/other.html', undefined, entry)).toBe(false)
    // Fail closed when the entry is unknown (e.g. dev mode).
    expect(isAppUrl(entry)).toBe(false)
  })

  it('rejects a file URL with the entry pathname on a remote host', () => {
    expect(isAppUrl('file://attacker.example/app/renderer/index.html', undefined, entry)).toBe(
      false,
    )
  })

  it('uses platform-correct path casing', () => {
    expect(isAppUrl('file:///APP/renderer/index.html', undefined, entry, 'linux')).toBe(false)
    expect(isAppUrl('file:///APP/renderer/index.html', undefined, entry, 'win32')).toBe(true)
  })

  it('never treats data: URLs as the app', () => {
    expect(isAppUrl('data:text/html,<script>alert(1)</script>', undefined, entry)).toBe(false)
    expect(isAppUrl('data:text/html,hi')).toBe(false)
  })

  it('keeps the Vite dev-server origin inside', () => {
    expect(isAppUrl('http://localhost:5173/', 'http://localhost:5173/')).toBe(true)
    expect(isAppUrl('http://localhost:3000/', 'http://localhost:5173/')).toBe(false)
  })

  it('treats agent-produced localhost links as external', () => {
    expect(isAppUrl('http://localhost:3000')).toBe(false)
  })
})
