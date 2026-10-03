import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('transcript Markdown', () => {
  it('renders GFM tables, fenced code, lists, and inline code', () => {
    const html = renderMarkdown(
      '## Plan\n\n- **Build** `Ari`\n\n| File | State |\n| --- | --- |\n| a.ts | Ready |\n\n```ts\nconst x = 1\n```',
    )
    expect(html).toContain('<h2>Plan</h2>')
    expect(html).toContain('<strong>Build</strong> <code>Ari</code>')
    expect(html).toContain('<table>')
    expect(html).toContain('class="language-ts"')
  })
  it('drops scripts, raw HTML, tracking images, and executable links', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel">\n\n![private](https://tracker.example)\n\n[run](javascript:alert%281%29)',
    )
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('tracker.example')
  })
})
