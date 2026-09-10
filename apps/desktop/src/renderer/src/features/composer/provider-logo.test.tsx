import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DriverKind } from '@ari/contracts/common'
import { ProviderLogo } from './provider-logo'

const LOGO_KINDS: DriverKind[] = ['claude', 'codex', 'opencode', 'grok', 'pi', 'hermes']

describe('ProviderLogo', () => {
  it.each(LOGO_KINDS)('renders the vendor glyph for %s, not the letter fallback', (kind) => {
    const { container } = render(<ProviderLogo kind={kind} />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('svg path')).not.toBeNull()
  })

  it('falls back to the letter mark for unknown kinds', () => {
    const { container } = render(<ProviderLogo kind="mystery" />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('M')
  })
})
