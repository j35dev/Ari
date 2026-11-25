import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
  it('gives a live image-generation call its own visible progress state', () => {
    render(
      <ActivityBurst
        row={row([
          call(
            'c1',
            'image_gen__imagegen',
            '{"prompt":"A quiet observatory above a sea of clouds"}',
          ),
        ])}
        active
      />,
    )

    expect(screen.getByRole('region', { name: 'Generating image' })).toBeInTheDocument()
    expect(screen.getByText('Rendering your image')).toBeInTheDocument()
    expect(screen.getByText('A quiet observatory above a sea of clouds')).toBeInTheDocument()
    expect(screen.getByText('0s')).toBeInTheDocument()
  })

  it('shows settled work as one line per command and edit, thoughts as thought lines', () => {
    const { container } = render(<ActivityBurst row={row(RUN)} active={false} />)

    expect(screen.getByRole('button', { name: 'Ran git status --short' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edited desktop/main.ts' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Edited .*types\.ts$/ })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Reasoning' })).toHaveLength(2)
    // Raw payloads stay closed behind each step's own disclosure.
    expect(screen.queryByText('"done"')).not.toBeInTheDocument()
    expect(container.querySelector('[data-activity="settled"]')).not.toBeNull()
    // Settled work is history: no working ring, no shimmer.
    expect(container.querySelector('.ari-status[data-status="working"]')).toBeNull()
    expect(container.querySelector('.ari-shimmer')).toBeNull()
  })

  it('shows live work as its steps, the running one named in the present tense', () => {
    const { container } = render(<ActivityBurst row={row(RUN.slice(0, 5))} active />)

    const live = container.querySelector('[data-activity="working"]')
    expect(live).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/^Working: Editing desktop\/main\.ts/),
    )
    expect(screen.getByRole('button', { name: 'Ran git status --short' })).toBeInTheDocument()
    const editing = screen.getByRole('button', { name: 'Editing desktop/main.ts' })
    expect(editing.querySelector('.ari-shimmer')).toHaveTextContent('Editing')
    expect(editing.querySelector('.ari-status[data-status="working"]')).not.toBeNull()
  })

  it('keeps the newest lines on screen and the rest behind one line', async () => {
    const user = userEvent.setup()
    const many: TranscriptBlock[] = []
    for (let i = 0; i < 8; i++) {
      many.push(call(`c${i}`, 'Bash', `{"command":"step ${i}"}`), result(`c${i}`))
    }
    render(<ActivityBurst row={row(many)} active />)

    expect(screen.queryByRole('button', { name: 'Ran step 1' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Ran step 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ran step 7' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '2 earlier steps' }))
    expect(screen.getByRole('button', { name: 'Ran step 0' })).toBeInTheDocument()
  })

  it('folds reads and searches into one Explored line that opens to them', async () => {
    const user = userEvent.setup()
    const looking = [
      call('c1', 'Read', '{"file_path":"src/a.ts"}'),
      result('c1'),
      call('c2', 'Grep', '{"pattern":"turnSettled"}'),
      result('c2'),
      call('c3', 'Read', '{"file_path":"src/b.ts"}'),
      result('c3'),
    ]
    render(<ActivityBurst row={row(looking)} active={false} />)

    const line = screen.getByRole('button', { name: 'Explored 2 files, 1 search' })
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Read src/a.ts' })).toBeNull()

    await user.click(line)
    expect(screen.getByRole('button', { name: 'Read src/a.ts' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Read src/b.ts' })).toBeInTheDocument()
  })

  it('lists an exploration under way, then folds it once the turn moves on', async () => {
    const looking = [call('c1', 'Read', '{"file_path":"src/a.ts"}'), result('c1')]
    const { container, rerender } = render(<ActivityBurst row={row(looking)} active />)

    const line = screen.getByRole('button', { name: 'Exploring 1 file' })
    expect(line).toHaveAttribute('aria-expanded', 'true')
    expect(line.querySelector('.ari-shimmer')).toHaveTextContent('Exploring')
    expect(screen.getByRole('button', { name: 'Read src/a.ts' })).toBeInTheDocument()

    rerender(<ActivityBurst row={row(looking)} active={false} />)

    const settled = await screen.findByRole('button', { name: 'Explored 1 file' })
    expect(settled).toHaveAttribute('aria-expanded', 'false')
    // The steps leave through the fold, then are gone.
    await waitFor(() => expect(container.querySelector('.ari-fold')).toBeNull())
  })

  it('keeps a failed step visible where it happened', () => {
    render(
      <ActivityBurst
        row={row([call('c1', 'Bash', '{"command":"pnpm verify"}'), result('c1', true)])}
        active={false}
      />,
    )

    const step = screen.getByRole('button', { name: 'Ran pnpm verify, error' })
    expect(step.querySelector('.ari-status[data-status="error"]')).not.toBeNull()
  })

  it('opens a step to its arguments and result', async () => {
    const user = userEvent.setup()
    const lone = [call('c1', 'Bash', '{"command":"git status --short"}'), result('c1')]
    render(<ActivityBurst row={row(lone)} active={false} />)

    await user.click(screen.getByRole('button', { name: 'Ran git status --short' }))

    expect(await screen.findByText('Ari Run')).toBeInTheDocument()
  })
})

describe('ActivityBurst in the terminal style', () => {
  it('names what the burst touched in one headline, open to every step', () => {
    render(<ActivityBurst row={row(RUN)} active={false} terminal />)

    const toggle = screen.getByRole('button', { expanded: true, name: /Edited main\.ts/ })
    expect(toggle).toHaveTextContent('main.ts, types.ts')
    expect(toggle).toHaveAccessibleName(/Edited main\.ts, types\.ts · Edited 2 files/)
    expect(screen.getByRole('button', { name: 'Ran git status --short' })).toBeInTheDocument()
  })

  it('counts failures in the headline', () => {
    render(
      <ActivityBurst
        row={row([call('c1', 'Bash', '{"command":"pnpm verify"}'), result('c1', true)])}
        active={false}
        terminal
      />,
    )

    const toggle = screen.getByRole('button', { name: 'Ran pnpm verify · Ran 1 command' })
    expect(toggle.textContent).toMatch(/1 failed/)
  })
})
