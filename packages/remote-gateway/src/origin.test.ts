import { describe, expect, it } from 'vitest'
import { isOriginAllowed, parseAllowedOrigins } from './origin'

const ALLOWED = parseAllowedOrigins('http://127.0.0.1:8787,https://connect.example.com')

describe('origin allowlist', () => {
  it('matches a listed origin exactly', () => {
    expect(isOriginAllowed('http://127.0.0.1:8787', ALLOWED)).toBe(true)
    expect(isOriginAllowed('https://connect.example.com', ALLOWED)).toBe(true)
  })

  it('rejects a different port on an allowed host', () => {
    expect(isOriginAllowed('http://127.0.0.1:9999', ALLOWED)).toBe(false)
  })

  it('rejects a different scheme on an allowed host', () => {
    expect(isOriginAllowed('https://127.0.0.1:8787', ALLOWED)).toBe(false)
  })

  it('rejects a subdomain of an allowed host', () => {
    expect(isOriginAllowed('https://evil.connect.example.com', ALLOWED)).toBe(false)
  })

  it('rejects a host that merely ends with an allowed one', () => {
    expect(isOriginAllowed('https://notconnect.example.com', ALLOWED)).toBe(false)
  })

  it('never allows a wildcard, in any spelling', () => {
    for (const value of ['*', 'http://*', 'https://*.example.com', 'null']) {
      expect(isOriginAllowed(value, ALLOWED)).toBe(false)
    }
  })

  it('rejects a missing origin rather than assuming same-origin', () => {
    // A browser always sends Origin on a cross-origin request; its absence
    // means a non-browser client, which must not inherit the browser's trust.
    expect(isOriginAllowed(undefined, ALLOWED)).toBe(false)
    expect(isOriginAllowed('', ALLOWED)).toBe(false)
  })

  it('allows nothing when the allowlist is empty', () => {
    expect(isOriginAllowed('http://127.0.0.1:8787', parseAllowedOrigins(''))).toBe(false)
  })

  it('ignores surrounding whitespace and empty entries in config', () => {
    const parsed = parseAllowedOrigins(' http://127.0.0.1:1 ,, https://a.example.com ')
    expect(parsed).toEqual(['http://127.0.0.1:1', 'https://a.example.com'])
  })

  it('compares case-insensitively, as hostnames are', () => {
    expect(isOriginAllowed('HTTPS://CONNECT.EXAMPLE.COM', ALLOWED)).toBe(true)
  })
})
