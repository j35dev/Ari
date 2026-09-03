import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ActivityStep } from './ActivityStep'
import type { TranscriptBlock } from './types'

afterEach(cleanup)

function call(name: string, argsJson: string): TranscriptBlock {
  return { key: 'k-c1', kind: 'tool-call', callId: 'c1', name, argsJson }
}

function result(isError = false): TranscriptBlock {
  return { key: 'r-c1', kind: 'tool-result', callId: 'c1', resultJson: '"done"', isError }
}

describe('ActivityStep', () => {
  it('reads verb + target and opens to arguments and result', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ActivityStep call={call('run_terminal_command', '{"command":"git status --short"}')} result={result()} />,
    )

    const toggle = screen.getByRole('button', { name: 'Ran git status --short' })
    expect(screen.queryByText('Ari Run')).not.toBeInTheDocument()

    await user.click(toggle)

    // The step brands itself as an Ari tool and shows the command, not raw JSON.
    expect(await screen.findByText('Ari Run')).toBeInTheDocument()
    expect(container.textContent).toContain('git status --short')
    expect(screen.queryByText(/"command": "git status --short"/)).not.toBeInTheDocument()
    expect(screen.getByText('"done"')).toBeInTheDocument()
  })

  it('names a targetless step by its tool instead of doubling verb + name', () => {
    render(<ActivityStep call={call('Edit', '{}')} result={result()} />)

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edited Edit' })).not.toBeInTheDocument()
  })

  it('advertises edit size and tenses a pending step live', () => {
    const edit = call('Edit', JSON.stringify({ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }))
    render(<ActivityStep call={edit} result={undefined} />)

    expect(screen.getByRole('button', { name: 'Editing src/a.ts' })).toBeInTheDocument()
    expect(screen.getByText('+1 −1')).toBeInTheDocument()
  })

  it('labels plan steps as done/total progress', () => {
    const args = JSON.stringify({
      items: [
        { text: 'a', status: 'done' },
        { text: 'b', status: 'pending' },
      ],
    })
    render(<ActivityStep call={call('todo_write', args)} result={result()} />)

    expect(screen.getByRole('button', { name: 'Updated 1/2' })).toBeInTheDocument()
  })

  it('reports what a step answered without opening it', () => {
    const bash: TranscriptBlock = {
      key: 'k-c1',
      kind: 'tool-call',
      callId: 'c1',
      name: 'Bash',
      argsJson: '{"command":"pnpm verify"}',
    }
    const answered: TranscriptBlock = {
      key: 'r-c1',
      kind: 'tool-result',
      callId: 'c1',
      resultJson: JSON.stringify({ output: 'one\ntwo\nthree', exitCode: 0 }),
    }
    render(<ActivityStep call={bash} result={answered} />)

    expect(screen.getByText('3 lines')).toBeInTheDocument()
  })

  it('marks a failed step in its accessible name and shows why', () => {
    const failure: TranscriptBlock = {
      key: 'r-c1',
      kind: 'tool-result',
      callId: 'c1',
      resultJson: JSON.stringify({ error: 'ENOENT: no such file' }),
      isError: true,
    }
    render(<ActivityStep call={call('Bash', '{"command":"pnpm verify"}')} result={failure} />)

    expect(screen.getByRole('button', { name: 'Ran pnpm verify, error' })).toBeInTheDocument()
    expect(screen.getByText('ENOENT: no such file')).toBeInTheDocument()
  })
})
