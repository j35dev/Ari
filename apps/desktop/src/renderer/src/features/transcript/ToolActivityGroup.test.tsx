import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolActivityGroup } from './ToolActivityGroup'
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
  thinking('t2', 'now the file'),
  call('c2', 'read_file', '{"file_path":"D:/Projects/Ari/apps/desktop/main.ts"}'),
  result('c2'),
]

describe('ToolActivityGroup collapsed state', () => {
  it('shows one summary line and hides every step until expanded', () => {
    render(<ToolActivityGroup row={row(RUN)} />)

    const toggle = screen.getByRole('button', { expanded: false })
    expect(toggle).toHaveTextContent('Ran 1 command · Read 1 file')
    expect(screen.queryByText('git status --short')).not.toBeInTheDocument()
    expect(screen.queryByText('weighing the options')).not.toBeInTheDocument()
  })

  it('stays collapsed while working, naming the in-flight call', () => {
    render(<ToolActivityGroup row={row(RUN.slice(0, 5))} />)

    expect(screen.getByRole('button', { expanded: false })).toHaveTextContent(
      'Reading desktop/main.ts',
    )
    expect(screen.getByLabelText('working')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ran git status --short' })).not.toBeInTheDocument()
  })

  it('compacts a settled burst until the user expands it', () => {
    render(<ToolActivityGroup row={row(RUN)} />)

    expect(screen.getByRole('button', { expanded: false })).toHaveTextContent(
      'Ran 1 command · Read 1 file',
    )
  })

  it('badges failures on the collapsed row', () => {
    render(<ToolActivityGroup row={row([call('c1', 'Bash', '{}'), result('c1', true)])} />)

    expect(screen.getByText('1 error')).toBeInTheDocument()
  })
})

describe('ToolActivityGroup expanded state', () => {
  it('lists one line per step in wire order, results folded into their call', async () => {
    const user = userEvent.setup()
    render(<ToolActivityGroup row={row(RUN)} />)

    await user.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getByRole('button', { name: 'Ran git status --short' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read desktop/main.ts' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Reasoning' })).toHaveLength(2)
    // Raw payloads stay closed behind their own step disclosure.
    expect(screen.queryByText('"done"')).not.toBeInTheDocument()
  })

  it('opens a single step to its arguments and result', async () => {
    const user = userEvent.setup()
    const { container } = render(<ToolActivityGroup row={row(RUN)} />)

    await user.click(screen.getByRole('button', { expanded: false }))
    await user.click(screen.getByRole('button', { name: 'Ran git status --short' }))

    // The step brands itself as an Ari tool and shows the command, not raw JSON.
    expect(await screen.findByText('Ari Run')).toBeInTheDocument()
    expect(container.textContent).toContain('git status --short')
    expect(screen.queryByText(/"command": "git status --short"/)).not.toBeInTheDocument()
    expect(screen.getByText('"done"')).toBeInTheDocument()
  })

  it('reveals a thought in full when its step is opened', async () => {
    const user = userEvent.setup()
    render(<ToolActivityGroup row={row(RUN)} />)

    await user.click(screen.getByRole('button', { expanded: false }))
    expect(screen.queryByText(/deeper detail here/)).not.toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: 'Reasoning' })[0]!)
    expect(screen.getByText(/deeper detail here/)).toBeInTheDocument()
  })

  it('names a targetless step by its tool instead of doubling verb + name', async () => {
    const user = userEvent.setup()
    render(<ToolActivityGroup row={row([call('c1', 'Edit', '{}'), result('c1')])} />)

    await user.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edited Edit' })).not.toBeInTheDocument()
  })

  it('advertises edit size and tenses pending steps live', async () => {
    const user = userEvent.setup()
    const edit = call(
      'c9',
      'Edit',
      JSON.stringify({ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }),
    )
    render(<ToolActivityGroup row={row([edit])} />)

    await user.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getAllByRole('button', { name: /Editing src\/a\.ts/ })).toHaveLength(2)
    expect(screen.getByText('+1 −1')).toBeInTheDocument()
  })

  it('labels plan steps as done/total progress', async () => {
    const user = userEvent.setup()
    const args = JSON.stringify({
      items: [
        { text: 'a', status: 'done' },
        { text: 'b', status: 'pending' },
      ],
    })
    render(<ToolActivityGroup row={row([call('c1', 'todo_write', args), result('c1')])} />)

    await user.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getByRole('button', { name: 'Updated 1/2' })).toBeInTheDocument()
  })
})
