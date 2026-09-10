// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PACKAGED_CONTENT_SECURITY_POLICY } from './window'

describe('packaged content security policy', () => {
  it('allows HTTPS audio without broadening the default source policy', () => {
    expect(PACKAGED_CONTENT_SECURITY_POLICY).toContain("default-src 'self'")
    expect(PACKAGED_CONTENT_SECURITY_POLICY).toContain("media-src 'self' https: blob:")
    expect(PACKAGED_CONTENT_SECURITY_POLICY).not.toContain('media-src *')
  })
})
