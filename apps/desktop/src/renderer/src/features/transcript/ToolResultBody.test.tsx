import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { isClippable, looksLikeUnifiedDiff, ToolResultBody } from './ToolResultBody'

const SAMPLE_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
].join('\n')

describe('looksLikeUnifiedDiff', () => {
  it('accepts a real unified diff', () => {
    expect(looksLikeUnifiedDiff(SAMPLE_DIFF)).toBe(true)
  })

  it('rejects plain text that merely mentions ---', () => {
    expect(looksLikeUnifiedDiff('--- all systems nominal\n@@ do not parse')).toBe(false)
  })

  it('rejects JSON payloads', () => {
    expect(looksLikeUnifiedDiff(JSON.stringify({ ok: true, rows: 3 }))).toBe(false)
  })
})

describe('isClippable', () => {
  it('clips dense single-line payloads', () => {
    expect(isClippable('x'.repeat(1300))).toBe(true)
  })

  it('clips by line count regardless of char length', () => {
    expect(isClippable(Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n'))).toBe(true)
  })

  it('leaves short output alone', () => {
    expect(isClippable('{"ok":true}')).toBe(false)
  })
})

describe('ToolResultBody', () => {
  it('renders the shared DiffViewer for diff-shaped results', () => {
    render(<ToolResultBody resultJson={SAMPLE_DIFF} />)
    expect(screen.getByLabelText('Toggle src/app.ts')).toBeInTheDocument()
  })

  it('pretty-prints non-diff results as raw text', () => {
    render(<ToolResultBody resultJson={'{"ok":true}'} />)
    expect(screen.getByText(/"ok": true/)).toBeInTheDocument()
  })

  it('keeps non-JSON results verbatim', () => {
    render(<ToolResultBody resultJson="wrote 42 bytes" />)
    expect(screen.getByText('wrote 42 bytes')).toBeInTheDocument()
  })

  it('offers a copy button on non-diff bodies', () => {
    render(<ToolResultBody resultJson={'{"ok":true}'} />)
    expect(screen.getByLabelText('Copy')).toBeInTheDocument()
  })

  it('gates long output behind a show-more toggle', async () => {
    const user = userEvent.setup()
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    render(<ToolResultBody resultJson={long} />)

    const toggle = screen.getByRole('button', { name: /Show more/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(screen.getByRole('button', { name: /Show less/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows no toggle for short output', () => {
    render(<ToolResultBody resultJson={'{"ok":true}'} />)
    expect(screen.queryByText(/Show more/)).not.toBeInTheDocument()
  })
})

describe('ToolResultBody MCP content', () => {
  const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  it('renders mixed text and image content as text plus a thumbnail', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ToolResultBody
        resultJson={JSON.stringify({
          content: [
            { type: 'text', text: 'Captured https://example.com' },
            { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
          ],
        })}
      />,
    )

    expect(screen.getByText('Captured https://example.com')).toBeInTheDocument()
    expect(screen.getByAltText('Tool result image 2')).toHaveAttribute(
      'src',
      `data:image/png;base64,${PNG_BASE64}`,
    )
    expect(container.textContent).not.toContain(PNG_BASE64)

    await user.click(screen.getByRole('button', { name: 'Open image 2' }))
    expect(screen.getByAltText('Full-size image-2.png')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(PNG_BASE64)
  })

  it('accepts a bare content array', () => {
    render(
      <ToolResultBody
        resultJson={JSON.stringify([{ type: 'image', data: PNG_BASE64, mimeType: 'image/webp' }])}
      />,
    )
    expect(screen.getByAltText('Tool result image 1')).toBeInTheDocument()
  })

  it.each([
    ['a non-image mimeType', { type: 'image', data: PNG_BASE64, mimeType: 'text/html' }],
    ['missing data', { type: 'image', mimeType: 'image/png' }],
    ['non-base64 data', { type: 'image', data: 'abc";alert(1)//', mimeType: 'image/png' }],
  ])('shows a placeholder for an image block with %s', (_, block) => {
    const { container } = render(
      <ToolResultBody resultJson={JSON.stringify({ content: [block] })} />,
    )
    expect(screen.getByText('Image unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.textContent).not.toContain(PNG_BASE64)
  })

  it('shows a placeholder for an oversized image block', () => {
    const huge = 'A'.repeat(5 * 1024 * 1024 + 4)
    const { container } = render(
      <ToolResultBody
        resultJson={JSON.stringify({
          content: [{ type: 'image', data: huge, mimeType: 'image/png' }],
        })}
      />,
    )
    expect(screen.getByText('Image too large to preview')).toBeInTheDocument()
    expect(container.textContent).not.toContain('AAAAAAAAAAAAAAAA')
  })

  it('shows a placeholder for non-text, non-image blocks beside an image', () => {
    render(
      <ToolResultBody
        resultJson={JSON.stringify([
          { type: 'resource', resource: { uri: 'file:///a.txt' } },
          { type: 'image', data: PNG_BASE64, mimeType: 'image/jpeg' },
        ])}
      />,
    )
    expect(screen.getByText('Unsupported content')).toBeInTheDocument()
    expect(screen.getByAltText('Tool result image 2')).toBeInTheDocument()
  })

  it('keeps text-only content results on the JSON path', () => {
    render(
      <ToolResultBody
        resultJson={JSON.stringify({ content: [{ type: 'text', text: 'hello' }] })}
      />,
    )
    expect(screen.getByText(/"text": "hello"/)).toBeInTheDocument()
  })
})
