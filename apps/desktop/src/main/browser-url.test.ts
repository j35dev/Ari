import { describe, expect, it } from 'vitest'
import { isBrowserNavigable, isSubframeNavigable, resolveBrowserUrl } from './browser-url'

describe('isBrowserNavigable', () => {
  it('allows http, https, and about:blank', () => {
    expect(isBrowserNavigable('https://example.com/x')).toBe(true)
    expect(isBrowserNavigable('http://localhost:5173/')).toBe(true)
    expect(isBrowserNavigable('about:blank')).toBe(true)
  })

  it('refuses file, javascript, data, and mailto', () => {
    expect(isBrowserNavigable('file:///etc/passwd')).toBe(false)
    expect(isBrowserNavigable('javascript:alert(1)')).toBe(false)
    expect(isBrowserNavigable('data:text/html,hi')).toBe(false)
    expect(isBrowserNavigable('mailto:hi@example.com')).toBe(false)
  })
})

describe('isSubframeNavigable', () => {
  it('lets frames render web, blank, data and blob documents', () => {
    for (const url of [
      'https://example.com/embed',
      'http://localhost:5173/',
      'about:blank',
      'about:srcdoc',
      'data:text/html,hi',
      'blob:https://example.com/0f6c',
    ])
      expect(isSubframeNavigable(url)).toBe(true)
  })

  it('refuses OS protocols, files, and unparseable URLs', () => {
    for (const url of [
      'ms-settings:privacy',
      'search-ms:query=x',
      'file:///C:/Windows/System32',
      'mailto:a@b.c',
      'ari://open',
      'not a url',
    ])
      expect(isSubframeNavigable(url)).toBe(false)
  })
})

describe('resolveBrowserUrl', () => {
  it('keeps an empty bar as a blank tab', () => {
    expect(resolveBrowserUrl('')).toEqual({ ok: true, url: 'about:blank' })
    expect(resolveBrowserUrl('  about:blank  ')).toEqual({ ok: true, url: 'about:blank' })
  })

  it('accepts http(s) URLs as written', () => {
    expect(resolveBrowserUrl('https://example.com/a')).toEqual({
      ok: true,
      url: 'https://example.com/a',
    })
    expect(resolveBrowserUrl('http://127.0.0.1:3000')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:3000/',
    })
  })

  it('prefixes https for public hosts and http for loopback', () => {
    expect(resolveBrowserUrl('example.com/docs')).toEqual({
      ok: true,
      url: 'https://example.com/docs',
    })
    expect(resolveBrowserUrl('localhost:5173')).toEqual({
      ok: true,
      url: 'http://localhost:5173/',
    })
  })

  it('rejects schemes the guest must never load', () => {
    expect(resolveBrowserUrl('file:///tmp/x')).toMatchObject({ ok: false })
    expect(resolveBrowserUrl('javascript:alert(1)')).toMatchObject({ ok: false })
    expect(resolveBrowserUrl('not a url')).toMatchObject({ ok: false })
  })
})
