import { describe, expect, it } from 'vitest'
import { formatUpdatedAt } from './format-updated'

describe('formatUpdatedAt', () => {
  const now = Date.parse('2026-09-15T12:00:00Z')

  it('names recent buckets', () => {
    expect(formatUpdatedAt('2026-09-15T11:59:40Z', now)).toBe('just now')
    expect(formatUpdatedAt('2026-09-15T11:50:00Z', now)).toBe('10m ago')
    expect(formatUpdatedAt('2026-09-15T09:00:00Z', now)).toBe('3h ago')
    expect(formatUpdatedAt('2026-09-13T12:00:00Z', now)).toBe('2d ago')
  })

  it('passes through unparseable values', () => {
    expect(formatUpdatedAt('never')).toBe('never')
  })
})
