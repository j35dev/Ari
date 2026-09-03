import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

/** Collapses the newlines remark inserts between block siblings. */
function flat(html: string): string {
  return html.replaceAll('\n', '')
}

describe('renderMarkdown', () => {
  it('renders paragraphs; single newlines become hard breaks', () => {
    expect(renderMarkdown('one\ntwo')).toBe('<p>one<br>\ntwo</p>')
    expect(flat(renderMarkdown('a\n\nb'))).toBe('<p>a</p><p>b</p>')
  })

  it('renders headings with inline formatting', () => {
    expect(renderMarkdown('## Title **bold**')).toBe('<h2>Title <strong>bold</strong></h2>')
  })

  it('renders fenced code blocks inert with language class', () => {
    const html = renderMarkdown('```ts\nconst a = "<b>&";\n```')
    expect(flat(html)).toBe(
      '<pre><code class="language-ts">const a = "&#x3C;b>&#x26;";</code></pre>',
    )
  })

  it('treats an unclosed fence as code to EOF (stream-safe)', () => {
    const html = renderMarkdown('```js\nlet x = 1;\nand **not bold**')
    expect(html).toContain('let x = 1;')
    expect(html).toContain('and **not bold**')
    expect(html).not.toContain('<strong>')
  })

  it('protects code spans from inline formatting', () => {
    expect(renderMarkdown('use `**x**` here')).toBe('<p>use <code>**x**</code> here</p>')
  })

  it('renders lists including nesting and ordered variants', () => {
    const html = flat(renderMarkdown('- a\n- b\n  - b1\n1. first\n2. second'))
    expect(html).toContain('<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul>')
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>')
  })

  it('renders blockquotes by recursive inner rendering', () => {
    expect(flat(renderMarkdown('> quoted **hi**'))).toBe(
      '<blockquote><p>quoted <strong>hi</strong></p></blockquote>',
    )
  })

  it('renders horizontal rules', () => {
    expect(renderMarkdown('---')).toBe('<hr>')
  })

  it('renders links and rejects unsafe href schemes', () => {
    // External links open as popups (OS browser), never a window navigation.
    expect(renderMarkdown('[site](https://x.y)')).toBe(
      '<p><a href="https://x.y" target="_blank" rel="noopener noreferrer">site</a></p>',
    )
    // Sanitizer strips the href entirely, leaving an inert anchor.
    expect(renderMarkdown('[evil](javascript:alert(1))')).toBe('<p><a>evil</a></p>')
  })

  it('autolinks bare URLs and <angle> forms', () => {
    expect(renderMarkdown('see https://a.b/c.')).toBe(
      '<p>see <a href="https://a.b/c" target="_blank" rel="noopener noreferrer">https://a.b/c</a>.</p>',
    )
    expect(renderMarkdown('<https://a.b>')).toBe(
      '<p><a href="https://a.b" target="_blank" rel="noopener noreferrer">https://a.b</a></p>',
    )
  })

  it('tags localhost links as external popups (dev-server preview case)', () => {
    expect(flat(renderMarkdown('[app](http://localhost:3000)'))).toBe(
      '<p><a href="http://localhost:3000" target="_blank" rel="noopener noreferrer">app</a></p>',
    )
  })

  it('drops raw HTML so injection cannot pass through', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror')
  })

  it('renders GFM tables with alignment', () => {
    const html = renderMarkdown('| a | b |\n| :-- | --: |\n| 1 | 2 |')
    expect(html).toContain('<th align="left">a</th>')
    expect(html).toContain('<td align="right">2</td>')
    expect(flat(html)).toContain('<tbody><tr><td')
  })

  it('renders strikethrough and emphasis combinations', () => {
    expect(renderMarkdown('~~gone~~ *em* __strong__ ***both***')).toBe(
      '<p><del>gone</del> <em>em</em> <strong>strong</strong> <em><strong>both</strong></em></p>',
    )
  })
})
