import { describe, expect, it } from 'vitest'
import { addBrowserPick, promptForPicks, takeBrowserPicks } from './browser-picks'
import type { PickedElement } from '@ari/contracts/rpc'

const el: PickedElement = {
  url: 'https://example.com/',
  selector: 'h1',
  tag: 'h1',
  text: 'Hello',
  role: null,
  ariaLabel: null,
  html: '<h1>Hello</h1>',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
}

describe('browser-picks', () => {
  it('formats taken picks as element_context for the agent', () => {
    takeBrowserPicks()
    addBrowserPick(el, null)
    const taken = takeBrowserPicks()
    expect(taken).toHaveLength(1)
    expect(promptForPicks(taken)).toContain('<element_context>')
    expect(promptForPicks(taken)).toContain('h1')
    expect(takeBrowserPicks()).toHaveLength(0)
  })
})
