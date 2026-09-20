import { describe, expect, it } from 'vitest'
import {
  elementChipLabel,
  formatElementContext,
  formatElementContexts,
  isPickedElement,
  type PickedElement,
} from './browser-element'

const button: PickedElement = {
  url: 'http://localhost:5173/',
  selector: 'button.primary',
  tag: 'button',
  text: 'Save changes',
  role: 'button',
  ariaLabel: null,
  html: '<button class="primary">Save changes</button>',
  x: 10,
  y: 20,
  width: 80,
  height: 32,
}

describe('formatElementContext', () => {
  it('names the page, selector, and text so the agent can find the node', () => {
    const block = formatElementContext(button)
    expect(block).toContain('http://localhost:5173/')
    expect(block).toContain('button.primary')
    expect(block).toContain('Save changes')
    expect(formatElementContexts([button])).toContain('<element_context>')
  })

  it('labels chips from visible text', () => {
    expect(elementChipLabel(button)).toBe('Save changes')
    expect(isPickedElement(button)).toBe(true)
    expect(isPickedElement({ tag: 'div' })).toBe(false)
  })
})
