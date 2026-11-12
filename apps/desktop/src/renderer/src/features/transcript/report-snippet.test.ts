import { describe, expect, it } from 'vitest'
import { reportSnippet } from './report-snippet'

describe('reportSnippet', () => {
  it('drops emphasis marks and keeps the words', () => {
    expect(reportSnippet('**Report** - **Concept:** *Orbital Garden*, a calm site')).toBe(
      'Report - Concept: Orbital Garden, a calm site',
    )
    expect(reportSnippet('__Done__ and ~~not this~~ and _that_')).toBe('Done and not this and that')
  })

  it('flattens headings, lists and line breaks into one line', () => {
    expect(reportSnippet('## Result\n\n- built the page\n- ran it\n\n1. checked links')).toBe(
      'Result built the page ran it checked links',
    )
  })

  it('keeps link and code text, without the syntax', () => {
    expect(reportSnippet('Saved to `sites/garden/index.html`, see [the page](file:///x).')).toBe(
      'Saved to sites/garden/index.html, see the page.',
    )
  })

  it('leaves names with underscores and stray asterisks alone', () => {
    expect(reportSnippet('Renamed user_profile_id; 2 * 3 stays')).toBe(
      'Renamed user_profile_id; 2 * 3 stays',
    )
  })

  it('skips fenced code and bounds the length', () => {
    expect(reportSnippet('Before\n```ts\nconst a = 1\n```\nafter')).toBe('Before after')
    expect(reportSnippet('word '.repeat(200)).length).toBeLessThanOrEqual(240)
  })
})
