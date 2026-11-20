import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DriverKind } from '@ari/contracts/common'
import { ProviderLogo } from './provider-logo'

const LOGO_KINDS: DriverKind[] = [
  'claude',
  'codex',
  'opencode',
  'grok',
  'pi',
  'hermes',
  'qoder',
  'muse',
  'deepseek',
]

describe('ProviderLogo', () => {
  it.each(LOGO_KINDS)('renders the vendor glyph for %s, not the letter fallback', (kind) => {
    const { container } = render(<ProviderLogo kind={kind} />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('svg path')).not.toBeNull()
  })

  it('draws the Qoder mark with its counters cut out', () => {
    const { container } = render(<ProviderLogo kind="qoder" />)
    const path = container.querySelector('svg path')
    expect(path?.getAttribute('fill-rule')).toBe('evenodd')
    expect(path?.getAttribute('d')?.match(/M/g)?.length).toBeGreaterThan(1)
  })

  it('keeps ari-core on the letter mark', () => {
    const { container } = render(<ProviderLogo kind="ari-core" />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('A')
  })

  it('falls back to the letter mark for unknown kinds', () => {
    const { container } = render(<ProviderLogo kind="mystery" />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('M')
  })
})
