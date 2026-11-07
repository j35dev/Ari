import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { DelegatedResultDiff } from './DelegatedResultDiff'
import { diffFixture, SNAPSHOT } from './result-fixtures.test-support'

vi.mock('../diffs/DiffSurface', () => ({
  DiffSurface: (props: { path: string; comparisonId: string; diffText: string }) => (
    <div data-testid="diff" data-path={props.path} data-comparison={props.comparisonId}>
      {props.diffText}
    </div>
  ),
}))
afterEach(cleanup)
const props = {
  open: true,
  onOpenChange: vi.fn(),
  title: 'Search API',
  version: 1,
  busy: false,
  error: null,
  onRetry: vi.fn(),
}

it('shows only the selected file and preserves the exact comparison for files and binaries', async () => {
  render(
    <DelegatedResultDiff
      {...props}
      diff={{
        ...diffFixture,
        files: [
          ...diffFixture.files,
          { path: 'second.ts', status: 'modified', additions: 1, deletions: 0, binary: false },
          { path: 'image.png', status: 'modified', additions: 0, deletions: 0, binary: true },
        ],
        patch: `${diffFixture.patch}diff --git a/second.ts b/second.ts\n--- a/second.ts\n+++ b/second.ts\n@@ -0,0 +1 @@\n+second\n`,
      }}
    />,
  )
  expect(screen.getByTestId('diff')).toHaveAttribute('data-path', 'src/search.ts')
  expect(screen.getByTestId('diff')).not.toHaveTextContent('+second')
  await userEvent.selectOptions(screen.getByLabelText('Result changed file'), 'second.ts')
  expect(screen.getByTestId('diff')).toHaveAttribute(
    'data-comparison',
    `${diffFixture.baseCommit}:${SNAPSHOT}`,
  )
  expect(screen.getByTestId('diff')).toHaveTextContent('+second')
  await userEvent.selectOptions(screen.getByLabelText('Result changed file'), 'image.png')
  expect(screen.getByText('Binary file changed. No text preview.')).toBeInTheDocument()
  expect(screen.queryByTestId('diff')).toBeNull()
})

it('bounds large previews and reports missing patches without claiming review', async () => {
  const { rerender } = render(
    <DelegatedResultDiff {...props} diff={{ ...diffFixture, patch: 'x'.repeat(2_000_001) }} />,
  )
  expect(screen.getByText(/changes have not been displayed/)).toBeInTheDocument()
  expect(screen.queryByTestId('diff')).toBeNull()
  rerender(<DelegatedResultDiff {...props} diff={{ ...diffFixture, patch: '' }} />)
  expect(screen.getByText('No text patch available for this file.')).toBeInTheDocument()
})

it('supports keyboard dismissal and restores focus to its trigger', async () => {
  function Review() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Review snapshot
        </button>
        <DelegatedResultDiff {...props} open={open} onOpenChange={setOpen} diff={diffFixture} />
      </>
    )
  }
  render(<Review />)
  const trigger = screen.getByRole('button', { name: 'Review snapshot' })
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('dialog', { name: 'Search API · Version 1' })
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(trigger).toHaveFocus()
})
