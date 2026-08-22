import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { looksLikeUnifiedDiff, ToolResultBody } from './ToolResultBody'

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
})

describe('ToolResultBlock integration', () => {
  it('expands to the diff card when opened', async () => {
    const { ToolResultBlock } = await import('./ToolBlocks')
    const block = {
      key: 'm0#1',
      kind: 'tool-result' as const,
      callId: 'c1',
      resultJson: SAMPLE_DIFF,
      isError: false,
    }
    render(<ToolResultBlock block={block} />)
    expect(screen.queryByLabelText('Toggle src/app.ts')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByLabelText('Toggle src/app.ts')).toBeInTheDocument()
  })
})
