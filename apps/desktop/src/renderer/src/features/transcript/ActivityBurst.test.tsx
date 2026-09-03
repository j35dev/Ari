import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ActivityBurst } from './ActivityBurst'
import type { ToolGroupRow, TranscriptBlock } from './types'

afterEach(cleanup)

function call(callId: string, name: string, argsJson: string): TranscriptBlock {
  return { key: `k-${callId}`, kind: 'tool-call', callId, name, argsJson }
}

function result(callId: string, isError = false): TranscriptBlock {
  return { key: `r-${callId}`, kind: 'tool-result', callId, resultJson: '"done"', isError }
}

function thinking(key: string, text: string): TranscriptBlock {
  return { key, kind: 'thinking', text }
}

function row(blocks: TranscriptBlock[]): ToolGroupRow {
  const resultsByCallId = new Map<string, TranscriptBlock>()
  for (const block of blocks) {
    if (block.kind === 'tool-result' && block.callId) resultsByCallId.set(block.callId, block)
  }
  return {
    kind: 'tool-group',
    key: 'g1',
    blocks,
    calls: blocks.filter((b) => b.kind === 'tool-call'),
    resultsByCallId,
  }
}

const RUN = [
  thinking('t1', 'weighing the options\ndeeper detail here'),
  call('c1', 'run_terminal_command', '{"command":"git status --short"}'),
  result('c1'),
  thinking('t2', 'now the files'),
  call('c2', 'Edit', '{"file_path":"D:/Projects/Ari/apps/desktop/main.ts"}'),
  result('c2'),
  call('c3', 'Edit', '{"file_path":"src/features/transcript/types.ts"}'),
  result('c3'),
]

describe('ActivityBurst collapsed', () => {
  it('names what the burst touched and hides every step until asked', () => {
    const { container } = render(<ActivityBurst row={row(RUN)} />)

    const toggle = screen.getByRole('button', { expanded: false })
    expect(toggle).toHaveTextContent('Edited')
    expect(toggle).toHaveTextContent('main.ts, types.ts')
    // The tally survives for screen readers without spending a row on it.
    expect(toggle).toHaveAccessibleName(/Edited main\.ts, types\.ts · Edited 2 files/)
    expect(screen.queryByText('git status --short')).not.toBeInTheDocument()
    expect(screen.queryByText('weighing the options')).not.toBeInTheDocument()
    expect(container.querySelector('[data-activity="settled"]')).not.toBeNull()
  })

  it('marks the rail live and names the in-flight call while working', () => {
    const { container } = render(<ActivityBurst row={row(RUN.slice(0, 5))} />)

    const toggle = screen.getByRole('button', { expanded: false })
    expect(toggle).toHaveTextContent('Editing')
    expect(toggle).toHaveAccessibleName(/^Working: Editing desktop\/main\.ts/)
    expect(container.querySelector('[data-activity="working"]')).not.toBeNull()
  })

  it('counts failures on the rail without shouting', () => {
    const { container } = render(
      <ActivityBurst row={row([call('c1', 'Bash', '{"command":"pnpm verify"}'), result('c1', true)])} />,
    )

    expect(screen.getByRole('button', { expanded: false })).toHaveAccessibleName(/1 failed$/)
    expect(container.querySelector('[data-activity="failed"]')).not.toBeNull()
  })

  it('falls back to a bucket phrase when nothing is nameable', () => {
    render(<ActivityBurst row={row([call('c1', 'Read', '{}'), result('c1')])} />)

    expect(screen.getByRole('button', { name: 'Read 1 file' })).toBeInTheDocument()
  })
})

describe('ActivityBurst expanded', () => {
  it('lists one row per step in wire order, results folded into their call', async () => {
    const user = userEvent.setup()
    render(<ActivityBurst row={row(RUN)} />)

    await user.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getByRole('button', { name: 'Ran git status --short' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edited desktop/main.ts' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Reasoning' })).toHaveLength(2)
    // Raw payloads stay closed behind their own step disclosure.
    expect(screen.queryByText('"done"')).not.toBeInTheDocument()
  })

  it('reveals a thought in full when its step is opened', async () => {
    const user = userEvent.setup()
    render(<ActivityBurst row={row(RUN)} />)

    await user.click(screen.getByRole('button', { expanded: false }))
    expect(screen.queryByText(/deeper detail here/)).not.toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: 'Reasoning' })[0]!)
    expect(screen.getByText(/deeper detail here/)).toBeInTheDocument()
  })

  it('opens a lone call straight to its body instead of a one-item list', async () => {
    const user = userEvent.setup()
    const lone = [call('c1', 'Bash', '{"command":"git status --short"}'), result('c1')]
    const { container } = render(<ActivityBurst row={row(lone)} />)

    await user.click(screen.getByRole('button', { expanded: false }))

    expect(await screen.findByText('Ari Run')).toBeInTheDocument()
    expect(container.textContent).toContain('git status --short')
    expect(screen.queryByRole('button', { name: 'Ran git status --short' })).not.toBeInTheDocument()
  })
})
