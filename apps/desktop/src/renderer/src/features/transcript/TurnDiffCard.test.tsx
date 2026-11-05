import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TurnDiffCard } from './TurnDiffCard'

function fileDiff(path: string, added: number, removed: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed} +1,${added} @@`,
    ...Array.from({ length: removed }, (_, i) => `-old ${i}`),
    ...Array.from({ length: added }, (_, i) => `+new ${i}`),
  ].join('\n')
}

const TWO_FILES = [fileDiff('src/a.ts', 3, 1), fileDiff('b.ts', 2, 0)].join('\n')

describe('TurnDiffCard', () => {
  it('sums the turn in one row and opens the diff', async () => {
    const user = userEvent.setup()
    render(<TurnDiffCard turnId="t1" diffText={TWO_FILES} />)

    expect(screen.getByText('Edited 2 files')).toBeInTheDocument()
    expect(screen.getByText('+5')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Turn diff: 2 files changed' })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('asks before undoing, then reports the files as restored', async () => {
    const user = userEvent.setup()
    const onUndo = vi.fn().mockResolvedValue(true)
    render(<TurnDiffCard turnId="t1" diffText={fileDiff('a.ts', 1, 0)} onUndo={onUndo} />)

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onUndo).not.toHaveBeenCalled()
    expect(screen.getByText(/Restore these files to before this turn/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Confirm undo' }))
    expect(onUndo).toHaveBeenCalledOnce()
    expect(await screen.findByText('Undid changes to 1 file')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })

  it('offers undo again when the revert fails', async () => {
    const user = userEvent.setup()
    const onUndo = vi.fn().mockResolvedValue(false)
    render(<TurnDiffCard turnId="t1" diffText={fileDiff('a.ts', 1, 0)} onUndo={onUndo} />)

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await user.click(screen.getByRole('button', { name: 'Confirm undo' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled())
    expect(screen.getByText('Edited 1 file')).toBeInTheDocument()
  })

  it('holds undo while a turn is running', () => {
    render(
      <TurnDiffCard turnId="t1" diffText={fileDiff('a.ts', 1, 0)} onUndo={vi.fn()} undoDisabled />,
    )
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
  })
})
