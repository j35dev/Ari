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

  it('shows a placeholder for an MCP image block without rendering its data', () => {
    const { container } = render(
      <ToolResultBody
        resultJson={JSON.stringify({
          content: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }],
        })}
      />,
    )
    expect(screen.getByText('Image')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain(PNG_BASE64)
    expect(document.body.innerHTML).not.toContain(PNG_BASE64)
  })

  it('shows a placeholder for an Anthropic image block without rendering its data', () => {
    const { container } = render(
      <ToolResultBody
        resultJson={JSON.stringify({
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 },
            },
          ],
        })}
      />,
    )
    expect(screen.getByText('Image')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain(PNG_BASE64)
    expect(document.body.innerHTML).not.toContain(PNG_BASE64)
  })

  it('shows text beside an MCP image placeholder without rendering an image', () => {
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
    expect(screen.getByText('Image')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain(PNG_BASE64)
    expect(document.body.innerHTML).not.toContain(PNG_BASE64)
  })

  it('shows a placeholder for non-text, non-image blocks beside an image', () => {
    const { container } = render(
      <ToolResultBody
        resultJson={JSON.stringify([
          { type: 'audio', data: PNG_BASE64, mimeType: 'audio/wav' },
          { type: 'image', data: PNG_BASE64, mimeType: 'image/jpeg' },
        ])}
      />,
    )
    expect(screen.getByText('Unsupported content')).toBeInTheDocument()
    expect(screen.getByText('Image')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(document.body.innerHTML).not.toContain(PNG_BASE64)
  })

  it('shows a placeholder for an audio-only result without leaking base64', () => {
    const { container } = render(
      <ToolResultBody
        resultJson={JSON.stringify({
          content: [{ type: 'audio', data: PNG_BASE64, mimeType: 'audio/wav' }],
        })}
      />,
    )
    expect(screen.getByText('Unsupported content')).toBeInTheDocument()
    expect(container.textContent).not.toContain(PNG_BASE64)
  })

  it('keeps text resources and resource links on the JSON path', () => {
    render(
      <ToolResultBody
        resultJson={JSON.stringify({
          content: [
            { type: 'text', text: 'see link' },
            {
              type: 'resource',
              resource: { uri: 'file:///a.ts', mimeType: 'text/plain', text: 'FILE_BODY' },
            },
            { type: 'resource_link', uri: 'file:///b.md', name: 'b.md' },
          ],
        })}
      />,
    )
    expect(screen.queryByText('Unsupported content')).toBeNull()
    expect(screen.getByText(/FILE_BODY/)).toBeInTheDocument()
    expect(screen.getByText(/file:\/\/\/a.ts/)).toBeInTheDocument()
    expect(screen.getByText(/file:\/\/\/b.md/)).toBeInTheDocument()
  })

  it('shows text beside a placeholder for mixed text and audio content', () => {
    const { container } = render(
      <ToolResultBody
        resultJson={JSON.stringify([
          { type: 'text', text: 'Recorded clip' },
          { type: 'audio', data: PNG_BASE64, mimeType: 'audio/wav' },
        ])}
      />,
    )
    expect(screen.getByText('Recorded clip')).toBeInTheDocument()
    expect(screen.getByText('Unsupported content')).toBeInTheDocument()
    expect(container.textContent).not.toContain(PNG_BASE64)
  })

  it('treats a text-typed block without string text as unsupported', () => {
    const { container } = render(
      <ToolResultBody
        resultJson={JSON.stringify({ content: [{ type: 'text', data: PNG_BASE64 }] })}
      />,
    )
    expect(screen.getByText('Unsupported content')).toBeInTheDocument()
    expect(container.textContent).not.toContain(PNG_BASE64)
  })

  it('keeps plain JSON arrays of untyped objects on the JSON path', () => {
    render(<ToolResultBody resultJson={JSON.stringify([{ path: 'src/a.ts' }])} />)
    expect(screen.getByText(/"path": "src\/a.ts"/)).toBeInTheDocument()
  })

  it('keeps Codex inputText results on the JSON path', () => {
    render(
      <ToolResultBody
        resultJson={JSON.stringify([{ type: 'inputText', text: 'hello from dynamic tool' }])}
      />,
    )
    expect(screen.queryByText('Unsupported content')).toBeNull()
    expect(screen.getByText(/"text": "hello from dynamic tool"/)).toBeInTheDocument()
  })

  it('keeps typed JSON arrays with non-MCP types on the JSON path', () => {
    render(<ToolResultBody resultJson={JSON.stringify([{ type: 'file', path: 'src/a.ts' }])} />)
    expect(screen.queryByText('Unsupported content')).toBeNull()
    expect(screen.getByText(/"path": "src\/a.ts"/)).toBeInTheDocument()
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
