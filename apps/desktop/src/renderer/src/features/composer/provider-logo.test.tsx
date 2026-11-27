import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DriverKind } from '@ari/contracts/common'
import { hasProviderLogo, ProviderLogo } from './provider-logo'

const LOGO_KINDS: DriverKind[] = [
  'claude',
  'codex',
  'opencode',
  'grok',
  'pi',
  'hermes',
  'qoder',
  'muse',
  'antigravity',
  'ari-core',
]

describe('ProviderLogo', () => {
  it.each(LOGO_KINDS)('renders the vendor glyph for %s, not the letter fallback', (kind) => {
    const { container } = render(<ProviderLogo kind={kind} />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('svg path')).not.toBeNull()
    expect(hasProviderLogo(kind)).toBe(true)
  })

  it('renders Antigravity with the shared grid, theme color and requested size', () => {
    const { container } = render(<ProviderLogo kind="antigravity" size={13} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg?.getAttribute('fill')).toBe('currentColor')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg).toHaveStyle({ width: '13px', height: '13px' })
    expect(svg).toHaveClass('text-fg-muted')
  })

  it('draws the Qoder mark with its counters cut out', () => {
    const { container } = render(<ProviderLogo kind="qoder" />)
    const path = container.querySelector('svg path')
    expect(path?.getAttribute('fill-rule')).toBe('evenodd')
    expect(path?.getAttribute('d')?.match(/M/g)?.length).toBeGreaterThan(1)
  })

  it('falls back to the letter mark for unknown kinds', () => {
    const { container } = render(<ProviderLogo kind="mystery" />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('M')
    expect(hasProviderLogo('mystery')).toBe(false)
    expect(hasProviderLogo(undefined)).toBe(false)
  })
})
