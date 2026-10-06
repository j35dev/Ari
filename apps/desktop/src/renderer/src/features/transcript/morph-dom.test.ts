import { describe, expect, it } from 'vitest'
import { morphNode } from './morph-dom'

function node(html: string): Element {
  const template = document.createElement('template')
  template.innerHTML = html
  const first = template.content.firstElementChild
  if (first === null) throw new Error('no element')
  return first
}

describe('morphNode', () => {
  it('grows a text node in place and keeps the nodes before it', () => {
    const current = node('<p><strong>done</strong> streaming te</p>')
    const strong = current.firstChild
    const text = current.lastChild

    expect(morphNode(current, node('<p><strong>done</strong> streaming text</p>'))).toBe(true)
    expect(current.outerHTML).toBe('<p><strong>done</strong> streaming text</p>')
    expect(current.firstChild).toBe(strong)
    expect(current.lastChild).toBe(text)
  })

  it('appends new children and removes surplus ones', () => {
    const list = node('<ul><li>a</li></ul>')
    const first = list.firstChild
    morphNode(list, node('<ul><li>a</li><li>b</li></ul>'))
    expect(list.outerHTML).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(list.firstChild).toBe(first)

    morphNode(list, node('<ul><li>a</li></ul>'))
    expect(list.outerHTML).toBe('<ul><li>a</li></ul>')
  })

  it('swaps a child whose element changed and syncs attributes', () => {
    const current = node('<p class="old" title="x"><em>a</em> b</p>')
    morphNode(current, node('<p class="new"><strong>a</strong> b</p>'))
    expect(current.outerHTML).toBe('<p class="new"><strong>a</strong> b</p>')
  })

  it('leaves highlighted lines alone when a line is appended', () => {
    const current = node('<code><span class="line">a</span>\n<span class="line">b</span></code>')
    const lines = Array.from(current.children)
    morphNode(
      current,
      node(
        '<code><span class="line">a</span>\n<span class="line">b</span>\n<span class="line">c</span></code>',
      ),
    )
    expect(Array.from(current.children).slice(0, 2)).toEqual(lines)
    expect(current.children).toHaveLength(3)
  })

  it('refuses a different element so the caller replaces it', () => {
    const current = node('<p>| a |</p>')
    expect(morphNode(current, node('<table></table>'))).toBe(false)
    expect(current.outerHTML).toBe('<p>| a |</p>')
  })
})
