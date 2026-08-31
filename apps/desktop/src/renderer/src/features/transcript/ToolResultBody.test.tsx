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
