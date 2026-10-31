import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewNavigator } from './ReviewNavigator'
import { FILE_MIME } from '../composer/drag-file'
import type { GitReviewFile } from '@ari/contracts/rpc'

const files: GitReviewFile[] = [
  {
    path: 'src/a.ts',
    kind: 'modified',
    additions: 2,
    deletions: 1,
    binary: false,
    staged: true,
    unstaged: true,
  },
  {
    path: 'src/b.ts',
    kind: 'untracked',
    additions: 1,
    deletions: 0,
    binary: false,
    staged: false,
    unstaged: true,
  },
]
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900)
})
afterEach(() => vi.restoreAllMocks())

describe('review navigation', () => {
  it('selects literal file paths, exposes counts and retains drag-to-mention', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onFilter = vi.fn()
    render(
      <ReviewNavigator
        files={files}
        selected="src/a.ts"
        filter=""
        commits={[]}
        onFilter={onFilter}
        onSelect={onSelect}
        onCommit={() => undefined}
      />,
    )
    expect(screen.getByText('2 changed files')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'src/a.ts' })).toHaveAttribute('aria-current', 'true')
    await user.click(screen.getByRole('button', { name: 'src/b.ts' }))
    expect(onSelect).toHaveBeenCalledWith('src/b.ts')
    const setData = vi.fn()
    fireEvent.dragStart(screen.getByRole('button', { name: 'src/a.ts' }), {
      dataTransfer: { setData, effectAllowed: '' },
    })
    expect(setData).toHaveBeenCalledWith(FILE_MIME, 'src/a.ts')
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter changed files' }), {
      target: { value: 'b.ts' },
    })
    expect(onFilter).toHaveBeenCalledWith('b.ts')
  })

  it('opens bounded history and selects an exact commit', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(
      <ReviewNavigator
        files={[]}
        selected={undefined}
        filter=""
        commits={[{ oid: 'a'.repeat(40), subject: 'Fix tests', author: 'Ari', at: '2026-01-01' }]}
        onFilter={() => undefined}
        onSelect={() => undefined}
        onCommit={onCommit}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Show commit history' }))
    await user.click(screen.getByRole('button', { name: /Fix tests/ }))
    expect(onCommit).toHaveBeenCalledWith('a'.repeat(40))
  })
})
