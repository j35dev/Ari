import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallDetails } from './ToolCallDetails'
import type { TranscriptBlock } from './types'

afterEach(cleanup)

function call(name: string, argsJson: string): TranscriptBlock {
  return { key: 'k1', kind: 'tool-call', callId: 'c1', name, argsJson }
}

describe('ToolCallDetails', () => {
  it('brands a shell call as Ari Run and shows the command', async () => {
    render(<ToolCallDetails call={call('Bash', '{"command":"pnpm verify"}')} />)

    expect(screen.getByText('Ari Run')).toBeInTheDocument()
    expect(screen.getByText('Bash')).toBeInTheDocument()
    // The command is present before and after the async Shiki swap.
    await screen.findByText('pnpm verify')
    expect(screen.getByLabelText('Copy')).toBeInTheDocument()
  })

  it('renders edits as Before/After panels', () => {
    render(
      <ToolCallDetails
        call={call(
          'Edit',
          JSON.stringify({ file_path: 'src/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' }),
        )}
      />,
    )

    expect(screen.getByText('Ari Edit')).toBeInTheDocument()
    expect(screen.getByText('Before')).toBeInTheDocument()
    expect(screen.getByText('const a = 1')).toBeInTheDocument()
    expect(screen.getByText('After')).toBeInTheDocument()
    expect(screen.getByText('const a = 2')).toBeInTheDocument()
  })

  it('labels read and search fields with shortened paths', () => {
    render(<ToolCallDetails call={call('read_file', '{"file_path":"D:/Projects/Ari/src/a.ts"}')} />)
    expect(screen.getByText('Ari Read')).toBeInTheDocument()
    expect(screen.getByText('file')).toBeInTheDocument()
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()

    cleanup()
    render(
      <ToolCallDetails
        call={call('Grep', JSON.stringify({ pattern: 'settle', path: 'packages/engine' }))}
      />,
    )
    expect(screen.getByText('Ari Search')).toBeInTheDocument()
    expect(screen.getByText('query')).toBeInTheDocument()
    expect(screen.getByText('settle')).toBeInTheDocument()
    expect(screen.getByText('scope')).toBeInTheDocument()
  })

  it('sends diff-bearing edit args through the diff viewer', () => {
    const diff =
      'diff --git a/a.ts b/a.ts\nindex 111..222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n'
    render(<ToolCallDetails call={call('apply_patch', JSON.stringify({ diff }))} />)

    expect(screen.getByText('Ari Edit')).toBeInTheDocument()
    expect(screen.getByText('patch')).toBeInTheDocument()
  })

  it('falls back to pretty JSON when no structured view applies', () => {
    render(<ToolCallDetails call={call('sparkle', '{"depth":3,"weird":"x"}')} />)

    expect(screen.getByText(/"depth": 3/)).toBeInTheDocument()
    expect(screen.queryByText('command')).not.toBeInTheDocument()
  })
})
