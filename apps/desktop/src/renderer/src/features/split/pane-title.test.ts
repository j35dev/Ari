import { describe, expect, it } from 'vitest'
import { formatPaneTitle } from './pane-title'

describe('formatPaneTitle', () => {
  it('joins a project name and session title with a hyphen', () => {
    expect(formatPaneTitle('New session', 'Ari')).toBe('Ari - New session')
  })

  it('falls back to the session title when there is no project', () => {
    expect(formatPaneTitle('Alpha', null)).toBe('Alpha')
    expect(formatPaneTitle('Alpha', undefined)).toBe('Alpha')
    expect(formatPaneTitle('Alpha', '')).toBe('Alpha')
  })

  it('stays null while the session itself has no name yet', () => {
    expect(formatPaneTitle(null, 'Ari')).toBe(null)
    expect(formatPaneTitle(undefined, 'Ari')).toBe(null)
    expect(formatPaneTitle('', 'Ari')).toBe(null)
  })
})
