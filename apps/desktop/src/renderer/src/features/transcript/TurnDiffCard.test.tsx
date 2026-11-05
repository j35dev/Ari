import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TurnDiffCard } from './TurnDiffCard'

function fileDiff(path: string, added: number, removed: number): string {
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed} +1,${added} @@`,
    ...Array.from({ length: removed }, (_, i) => `-old ${i}`),
    ...Array.from({ length: added }, (_, i) => `+new ${i}`),
  ]
  return lines.join('\n')
}

const FIVE_FILES = [
  fileDiff('src/a.ts', 3, 1),
  fileDiff('src/lib/b.ts', 2, 0),
  fileDiff('c.ts', 1, 1),
  fileDiff('docs/d.md', 4, 0),
  fileDiff('e.ts', 0, 2),
].join('\n')

describe('TurnDiffCard', () => {
  it('summarizes the turn and lists the first files with their counts', () => {
    render(<TurnDiffCard turnId="t1" diffText={FIVE_FILES} />)

    expect(screen.getByText('Edited 5 files')).toBeInTheDocument()
    expect(screen.getByText('+10')).toBeInTheDocument()
    expect(screen.getByText('−4')).toBeInTheDocument()
    expect(screen.getByTitle('src/a.ts')).toBeInTheDocument()
    expect(screen.getByTitle('c.ts')).toBeInTheDocument()
    expect(screen.queryByTitle('docs/d.md')).not.toBeInTheDocument()
  })

  it('reveals the rest of the files on request', async () => {
    const user = userEvent.setup()
    render(<TurnDiffCard turnId="t1" diffText={FIVE_FILES} />)

    await user.click(screen.getByRole('button', { name: 'Show 2 more files' }))
    expect(screen.getByTitle('docs/d.md')).toBeInTheDocument()
    expect(screen.getByTitle('e.ts')).toBeInTheDocument()
  })

  it('opens the full diff from Review or from a file row', async () => {
    const user = userEvent.setup()
    render(<TurnDiffCard turnId="t1" diffText={FIVE_FILES} />)

    const review = screen.getByRole('button', { name: 'Turn diff: 5 files changed' })
    expect(review).toHaveAttribute('aria-expanded', 'false')
    await user.click(screen.getByTitle('src/lib/b.ts'))
    expect(review).toHaveAttribute('aria-expanded', 'true')
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
      <TurnDiffCard
        turnId="t1"
        diffText={fileDiff('a.ts', 1, 0)}
        onUndo={vi.fn()}
        undoDisabled
      />,
    )
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
  })
})
