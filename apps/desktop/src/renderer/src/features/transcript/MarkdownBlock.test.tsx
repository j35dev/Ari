import { act, fireEvent, render, screen, within } from '@testing-library/react'
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

  it('re-parses a large growing block at most once per interval, then lands the end', () => {
    vi.useFakeTimers()
    try {
      const rows = (n: number): string =>
        Array.from({ length: n }, (_, i) => `- item ${i} ${'x'.repeat(40)}`).join('\n')
      const { container, rerender } = render(<MarkdownBlock text={rows(60)} streaming />)
      rerender(<MarkdownBlock text={rows(61)} streaming />)
      rerender(<MarkdownBlock text={rows(62)} streaming />)
      expect(root(container).querySelectorAll('li')).toHaveLength(60)

      act(() => {
        vi.advanceTimersByTime(150)
      })
      expect(root(container).querySelectorAll('li')).toHaveLength(62)

      rerender(<MarkdownBlock text={rows(63)} streaming />)
      rerender(<MarkdownBlock text={rows(64)} />)
      expect(root(container).querySelectorAll('li')).toHaveLength(64)
    } finally {
      vi.useRealTimers()
    }
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

  it('renders a visual in reply order and preserves its controls as prose streams', () => {
    const source = JSON.stringify({
      version: 1,
      type: 'bar',
      title: 'Work',
      labels: ['A'],
      series: [
        { name: 'One', values: [2] },
        { name: 'Two', values: [3] },
      ],
    })
    const text = `Before\n\n\`\`\`ari-viz\n${source}\n\`\`\`\n\nAfter`
    const { container, rerender } = render(<MarkdownBlock text={text} streaming />)
    const figure = screen.getByRole('figure', { name: 'Work' })
    fireEvent.click(within(figure).getByRole('button', { name: 'One' }))
    rerender(<MarkdownBlock text={`${text} grows`} streaming />)
    expect(screen.getByRole('figure', { name: 'Work' })).toBe(figure)
    expect(within(figure).getByRole('button', { name: 'One' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(container.querySelector('.ari-visual-reply')?.firstElementChild).toHaveTextContent(
      'Before',
    )
    expect(container.querySelector('.ari-visual-reply')?.lastElementChild).toHaveTextContent(
      'After grows',
    )
    expect(container.querySelector('code.language-ari-viz')).toBeNull()
  })

  it('waits for a closing fence while streaming and settles an interrupted visual', () => {
    const partial = '```ari-viz\n{"type":"metrics"'
    const { rerender } = render(<MarkdownBlock text={partial} streaming />)
    expect(screen.getByRole('status')).toHaveTextContent('Building visualization')
    rerender(<MarkdownBlock text={partial} />)
    expect(screen.queryByText('Building visualization…')).toBeNull()
    expect(screen.getByText('Visualization unavailable')).toBeInTheDocument()
    rerender(
      <MarkdownBlock
        text={
          '```ari-viz\n{"type":"metrics","title":"Count","items":[{"label":"Total","value":4}]}\n```'
        }
      />,
    )
    expect(screen.getByRole('figure', { name: 'Count' })).toBeInTheDocument()
  })
})

// Assistant replies in every desktop session, including a lead, a worker, and
// Aria, reach MarkdownBlock from TranscriptView. User bubbles stay plain text.
// DelegatedResult renders a child result summary through this same component.
const flatMetrics =
  '{"version":1,"type":"metrics","title":"Saved","items":[{"label":"Hours","value":4}]}'
const wrappedTimeline =
  '{"version":1,"type":"timeline","title":"Release progress","data":{"events":[{"label":"v0.2.0","date":"2026-08-30","description":"Previous release"},{"label":"v0.3.13","date":"in progress","tone":"warning"}]}}'

describe('reply visualization contract', () => {
  it('renders a flat chart and one wrapped timeline in reply order', () => {
    const text = [
      'Before',
      '',
      '```ari-viz',
      flatMetrics,
      '```',
      '',
      '```ari-viz',
      wrappedTimeline,
      '```',
      '',
      'After',
    ].join('\n')
    const { container } = render(<MarkdownBlock text={text} />)
    expect(screen.getByRole('figure', { name: 'Saved' })).toBeInTheDocument()
    expect(screen.getByText('Hours')).toBeInTheDocument()
    const timeline = screen.getByRole('figure', { name: 'Release progress' })
    expect(within(timeline).getByText('v0.2.0').closest('li')?.getAttribute('style')).toContain(
      'var(--ari-accent)',
    )
    expect(within(timeline).getByText('v0.3.13').closest('li')?.getAttribute('style')).toContain(
      'var(--ari-warning)',
    )
    expect(container.querySelector('.ari-visual-reply')?.firstElementChild).toHaveTextContent(
      'Before',
    )
    expect(container.querySelector('.ari-visual-reply')?.lastElementChild).toHaveTextContent(
      'After',
    )
    expect(container.querySelector('code.language-ari-viz')).toBeNull()
  })

  it('names the missing field and does not echo markup from an extra key', () => {
    const { rerender } = render(
      <MarkdownBlock
        text={'```ari-viz\n{"version":1,"type":"timeline","title":"Missing events"}\n```'}
      />,
    )
    expect(screen.getByText('Timeline charts need events.')).toBeInTheDocument()
    expect(screen.queryByText('Invalid input')).toBeNull()
    rerender(
      <MarkdownBlock
        text={
          '```ari-viz\n{"version":1,"type":"timeline","title":"Marked up","events":[{"label":"A"}],"html":"<script>alert(1)</script>"}\n```'
        }
      />,
    )
    expect(screen.getByText('Timeline charts cannot include "html".')).toBeInTheDocument()
    expect(screen.queryByText(/alert\(1\)/)).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })
})
