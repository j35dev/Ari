import { describe, expect, it } from 'vitest'

describe('DOM test environment', () => {
  it('DOM suites load the DOM test setup', () => {
    expect(typeof Element).toBe('function')
    expect(typeof Element.prototype.getAnimations).toBe('function')
    expect(Element.prototype.getAnimations.call(document.createElement('div'))).toEqual([])
    expect(globalThis.ResizeObserver).toBeDefined()
    expect(document.body).toBeInTheDocument()
  })
})
