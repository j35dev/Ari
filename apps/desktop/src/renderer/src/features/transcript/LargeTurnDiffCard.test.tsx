import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitTurnDiffSummary } from '@ari/contracts/rpc'
import { TurnDiffCard } from './TurnDiffCard'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))
const summary: GitTurnDiffSummary = {
  baseOid: 'a'.repeat(40),
  headOid: 'b'.repeat(40),
  files: [
    {
      path: 'a.txt',
      kind: 'modified',
      additions: 3000,
      deletions: 20,
      binary: false,
      staged: false,
      unstaged: false,
    },
    {
      path: 'b.txt',
      oldPath: 'old.txt',
      kind: 'renamed',
      additions: 4000,
      deletions: 10,
      binary: false,
      staged: false,
      unstaged: false,
    },
    {
      path: 'image.png',
      kind: 'modified',
      additions: 0,
      deletions: 0,
      binary: true,
      staged: false,
      unstaged: false,
    },
  ],
}
function patch(path: string, content: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${content}\n`
}
function renderCard() {
  return render(<TurnDiffCard turnId="turn_1" diffText="" summary={summary} sessionId="sess_1" />)
}

describe('large turn diff cards', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue({ diffText: patch('a.txt', 'first file') })
  })

  it('shows full counts while collapsed and only loads the selected file on expansion', async () => {
    const user = userEvent.setup()
    renderCard()
    const toggle = screen.getByRole('button', { name: 'Turn diff: 3 files changed' })
    expect(screen.getByText('+7000')).toBeInTheDocument()
    expect(screen.getByText('−30')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
    await user.click(toggle)
    expect(await screen.findByText('first file')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledExactlyOnceWith('git.turnDiffFile', {
      sessionId: 'sess_1',
      baseOid: summary.baseOid,
      headOid: summary.headOid,
      path: 'a.txt',
    })
    await user.click(toggle)
    await user.click(toggle)
    expect(screen.getByText('first file')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledTimes(1)
    invoke.mockResolvedValueOnce({ diffText: patch('b.txt', 'second file') })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Changed file' }), 'b.txt')
    expect(await screen.findByText('second file')).toBeInTheDocument()
    expect(screen.queryByText('first file')).not.toBeInTheDocument()
    expect(invoke).toHaveBeenLastCalledWith('git.turnDiffFile', {
      sessionId: 'sess_1',
      baseOid: summary.baseOid,
      headOid: summary.headOid,
      path: 'b.txt',
      oldPath: 'old.txt',
    })
  })

  it('shows a neutral limit message and still allows review of other files and binaries', async () => {
    const user = userEvent.setup()
    invoke.mockResolvedValueOnce({ diffText: null, tooLarge: true })
    renderCard()
    await user.click(screen.getByRole('button', { name: /Turn diff:/ }))
    expect(
      await screen.findByText('This file is too large to preview in chat.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
    invoke.mockResolvedValueOnce({ diffText: patch('b.txt', 'reviewable') })
    await user.selectOptions(screen.getByLabelText('Changed file'), 'b.txt')
    expect(await screen.findByText('reviewable')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Changed file'), 'image.png')
    expect(screen.getByText('Binary file changed.')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('ignores late responses for an earlier selected file', async () => {
    const user = userEvent.setup()
    let resolveFirst!: (value: { diffText: string }) => void
    invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve
      }),
    )
    renderCard()
    await user.click(screen.getByRole('button', { name: /Turn diff:/ }))
    invoke.mockResolvedValueOnce({ diffText: patch('b.txt', 'current file') })
    await user.selectOptions(screen.getByLabelText('Changed file'), 'b.txt')
    expect(await screen.findByText('current file')).toBeInTheDocument()
    await act(async () => {
      resolveFirst({ diffText: patch('a.txt', 'stale file') })
    })
    expect(screen.queryByText('stale file')).not.toBeInTheDocument()
  })

  it('retries a transient file failure without retrying the entire turn', async () => {
    const user = userEvent.setup()
    invoke.mockRejectedValueOnce(new Error('IPC failed'))
    renderCard()
    await user.click(screen.getByRole('button', { name: /Turn diff:/ }))
    await user.click(await screen.findByRole('button', { name: 'Retry file diff' }))
    expect(await screen.findByText('first file')).toBeInTheDocument()
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
  })
})
