import { describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from './markdown'
import * as markdown from './markdown'
import { createMarkdownStream } from './markdown-stream'

/** Collapses the newlines remark inserts between block siblings. */
function flat(html: string): string {
  return html.replaceAll('\n', '')
}

const REPLY = [
  '# Plan',
  '',
  'First **paragraph** with `code` and a [link](https://a.b).',
  'Second line of it.',
  '',
  '- one',
  '- two',
  '  - nested',
  '',
  '1. first',
  '',
  '   continued under the item',
  '2. second',
  '',
  '```ts',
  'const a = 1',
  '',
  'const b = 2',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '> quoted',
  '> twice',
  '',
  'Setext title',
  '---',
  '',
  '    indented code',
  '',
  'closing words',
].join('\n')

describe('createMarkdownStream', () => {
  it('yields one HTML string per top-level block', () => {
    const blocks = createMarkdownStream().render('# Title\n\npara\n\n- a\n- b')
    expect(blocks.map(flat)).toEqual([
      '<h1>Title</h1>',
      '<p>para</p>',
      '<ul><li>a</li><li>b</li></ul>',
    ])
  })

  it('matches a single pass over the source at every point of a stream', () => {
    const stream = createMarkdownStream()
    // Uneven chunks, so cuts land mid-word, mid-fence and mid-table.
    for (let end = 1; end <= REPLY.length; end += 7) {
      const source = REPLY.slice(0, end)
      expect(flat(stream.render(source).join(''))).toBe(flat(renderMarkdown(source)))
    }
    expect(flat(stream.render(REPLY).join(''))).toBe(flat(renderMarkdown(REPLY)))
  })

  it('parses only the block still being written', () => {
    const parse = vi.spyOn(markdown.markdownProcessor, 'parse')
    const stream = createMarkdownStream()
    stream.render('first paragraph\n\nsecond')
    stream.render('first paragraph\n\nsecond grows')

    expect(parse.mock.calls.map(([source]) => source)).toEqual([
      'first paragraph\n\nsecond',
      'second grows',
    ])
    parse.mockRestore()
  })

  it('keeps finished blocks byte-identical while a later one grows', () => {
    const stream = createMarkdownStream()
    const before = stream.render('```ts\nconst a = 1\n```\n\ntail')
    const after = stream.render('```ts\nconst a = 1\n```\n\ntail keeps growing')

    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
  })

  it('resolves a reference defined after the text that uses it', () => {
    const stream = createMarkdownStream()
    stream.render('see [the docs][d]\n\nmore')
    const source = 'see [the docs][d]\n\nmore\n\n[d]: https://a.b'
    expect(flat(stream.render(source).join(''))).toBe(flat(renderMarkdown(source)))
  })

  it('starts over when the text is replaced rather than appended to', () => {
    const stream = createMarkdownStream()
    stream.render('one\n\ntwo\n\nthree')
    expect(stream.render('different').map(flat)).toEqual(['<p>different</p>'])
  })
})
