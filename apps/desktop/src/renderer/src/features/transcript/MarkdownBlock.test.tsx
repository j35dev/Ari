import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const highlight = vi.hoisted(() => ({
  highlightCode: vi.fn<(code: string, lang: string) => Promise<string | null>>(),
  highlightCodeSync: vi.fn<(code: string, lang: string, compute: boolean) => string | null>(),
}))

vi.mock('./highlight', () => ({
  ...highlight,
  shikiInner: (html: string) => html,
  // No warm highlighter: fenced code takes the whole-block path under test here.
  warmHighlighter: () => null,
  HIGHLIGHT_THEME_OPTIONS: {},
}))

import { MarkdownBlock } from './MarkdownBlock'

const colored = (code: string): string =>
  code
    .split('\n')
    .map((line) => `<span class="line">${line}</span>`)
    .join('\n')

function root(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.ari-md')
  if (el === null) throw new Error('no markdown root')
  return el
}

describe('MarkdownBlock', () => {
  beforeEach(() => {
    highlight.highlightCode.mockReset().mockResolvedValue(null)
    highlight.highlightCodeSync.mockReset().mockReturnValue(null)
  })

  it('renders each top-level block as a direct child', () => {
    const { container } = render(<MarkdownBlock text={'# Title\n\nbody **bold**'} />)
    expect(root(container).innerHTML).toBe('<h1>Title</h1><p>body <strong>bold</strong></p>')
  })

  it('keeps finished blocks and grows the live one in place as text streams', () => {
    const { container, rerender } = render(<MarkdownBlock text={'first\n\nsec'} streaming />)
    const [first, second] = Array.from(root(container).children)

    rerender(<MarkdownBlock text={'first\n\nsecond grows\n\nthird'} streaming />)

    const after = Array.from(root(container).children)
    expect(after).toHaveLength(3)
    expect(after[0]).toBe(first)
    expect(after[1]).toBe(second)
    expect(second?.textContent).toBe('second grows')
  })

  it('marks the reply a running turn is writing', () => {
    const { container, rerender } = render(<MarkdownBlock text="hi" streaming />)
    expect(root(container)).toHaveAttribute('data-streaming')
    rerender(<MarkdownBlock text="hi" />)
    expect(root(container)).not.toHaveAttribute('data-streaming')
  })

  it('drops blocks the new text no longer has', () => {
    const { container, rerender } = render(<MarkdownBlock text={'one\n\ntwo\n\nthree'} />)
    rerender(<MarkdownBlock text="only" />)
    expect(root(container).innerHTML).toBe('<p>only</p>')
  })

  it('colors a first paint afterwards, without blocking it', async () => {
    highlight.highlightCode.mockImplementation((code) => Promise.resolve(colored(code)))
    const { container } = render(<MarkdownBlock text={'```ts\nlet a\n```'} />)

    expect(highlight.highlightCodeSync).toHaveBeenCalledWith('let a\n', 'ts', false)
    expect(root(container).querySelector('code')?.innerHTML).toBe('let a\n')
    await vi.waitFor(() =>
      expect(root(container).querySelectorAll('code .line').length).toBeGreaterThan(0),
    )
  })

  it('keeps streaming code colored in the frame it grows, reusing earlier lines', () => {
    highlight.highlightCodeSync.mockImplementation((code, _lang, compute) =>
      compute ? colored(code) : null,
    )
    const { container, rerender } = render(<MarkdownBlock text={'```ts\nlet a'} streaming />)
    rerender(<MarkdownBlock text={'```ts\nlet a\nlet b'} streaming />)

    const code = root(container).querySelector('code')
    // remark ends code with a newline, so the highlighter adds an empty last line.
    const lines = Array.from(code?.querySelectorAll('.line') ?? [])
    expect(lines.map((line) => line.textContent)).toEqual(['let a', 'let b', ''])

    rerender(<MarkdownBlock text={'```ts\nlet a\nlet b\nlet c'} streaming />)

    const grown = Array.from(code?.querySelectorAll('.line') ?? [])
    expect(grown.map((line) => line.textContent)).toEqual(['let a', 'let b', 'let c', ''])
    expect(grown[0]).toBe(lines[0])
    expect(grown[1]).toBe(lines[1])
    expect(root(container).querySelector('code')).toBe(code)
  })

  it('never applies a late highlight to code that has since changed', async () => {
    let release: (html: string) => void = () => undefined
    highlight.highlightCode.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    const { container, rerender } = render(<MarkdownBlock text={'```ts\nlet a'} />)
    rerender(<MarkdownBlock text={'```ts\nlet a\nlet b'} />)
    release(colored('let a'))
    await Promise.resolve()

    expect(root(container).querySelector('code')?.textContent).toBe('let a\nlet b\n')
    expect(root(container).querySelector('.line')).toBeNull()
  })
})
