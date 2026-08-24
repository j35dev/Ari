import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DiffViewer } from './DiffViewer'

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' const one = 1',
  '-const two = 2',
  '+const two = 22',
  '+const three = 3',
  ' console.log(one)',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
].join('\n')

describe('DiffViewer', () => {
  it('renders a header row per file with path and +/- count badges', () => {
    const { container } = render(<DiffViewer diffText={DIFF} />)
    expect(screen.getByText('src/app.ts')).toBeInTheDocument()
    expect(screen.getByText('assets/logo.png')).toBeInTheDocument()
    const added = screen.getByText('+2')
    const removed = screen.getByText('-1')
    expect(added).toHaveClass('text-success')
    expect(removed).toHaveClass('text-danger')
    expect(container.querySelectorAll('section[data-file-path]')).toHaveLength(2)
  })

  it('tints add rows with success-subtle and del rows with danger-subtle', () => {
    const { container } = render(<DiffViewer diffText={DIFF} />)
    const addRow = container.querySelector('[data-line-type="add"]')
    const delRow = container.querySelector('[data-line-type="del"]')
    const contextRow = container.querySelector('[data-line-type="context"]')
    expect(addRow).toHaveClass('bg-success-subtle')
    expect(delRow).toHaveClass('bg-danger-subtle')
    expect(contextRow).not.toHaveClass('bg-success-subtle')
    expect(contextRow).not.toHaveClass('bg-danger-subtle')
  })

  it('shows old/new line number gutters per row', () => {
    const { container } = render(<DiffViewer diffText={DIFF} />)
    const delRow = container.querySelector('[data-line-type="del"]')
    const addRow = container.querySelector('[data-line-type="add"]')
    expect(delRow?.children[0]?.textContent).toBe('2')
    expect(delRow?.children[1]?.textContent).toBe('')
    expect(addRow?.children[0]?.textContent).toBe('')
    expect(addRow?.children[1]?.textContent).toBe('2')
    expect(delRow?.querySelector('pre')?.textContent).toBe('const two = 2')
  })

  it('collapses and expands a file body via the header chevron', async () => {
    const user = userEvent.setup()
    const { container } = render(<DiffViewer diffText={DIFF} />)
    const section = container.querySelector('section[data-file-path="src/app.ts"]')
    if (!section) throw new Error('file card missing')
    const body = section.lastElementChild as HTMLElement
    expect(body.className).toContain('grid-rows-[1fr]')

    const toggle = screen.getByRole('button', { name: 'Toggle src/app.ts' })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(body.className).toContain('grid-rows-[0fr]')

    await user.click(toggle)
    expect(body.className).toContain('grid-rows-[1fr]')
  })

  it('renders binary files without line rows', () => {
    const { container } = render(<DiffViewer diffText={DIFF} />)
    const section = container.querySelector('section[data-file-path="assets/logo.png"]')
    expect(section?.querySelector('[data-line-type]')).toBeNull()
    expect(screen.getByText('binary')).toBeInTheDocument()
  })

  it('shows an empty state for input without any diff', () => {
    render(<DiffViewer diffText="not a diff at all" />)
    expect(screen.getByText('No changes')).toBeInTheDocument()
  })
})

describe('DiffViewer review notes (M21.1)', () => {
  it('hides comment affordances without onLineComment', () => {
    render(<DiffViewer diffText={DIFF} />)
    expect(
      screen.queryByRole('button', { name: /Comment on src\/app.ts/ }),
    ).not.toBeInTheDocument()
  })

  it('saves an inline note and reports path, line, and text', async () => {
    const user = userEvent.setup()
    const onLineComment = vi.fn()
    render(<DiffViewer diffText={DIFF} onLineComment={onLineComment} />)

    await user.click(screen.getAllByRole('button', { name: /Comment on src\/app.ts/ })[0]!)
    const box = screen.getByLabelText(/Review note for/)
    await user.type(box, 'extract this into a helper')
    await user.click(screen.getByRole('button', { name: 'Save note' }))

    expect(onLineComment).toHaveBeenCalledOnce()
    expect(onLineComment).toHaveBeenCalledWith({
      path: 'src/app.ts',
      line: 1,
      text: 'extract this into a helper',
    })
  })

  it('does not save empty notes and cancel dismisses the editor', async () => {
    const user = userEvent.setup()
    const onLineComment = vi.fn()
    render(<DiffViewer diffText={DIFF} onLineComment={onLineComment} />)

    await user.click(screen.getAllByRole('button', { name: /Comment on src\/app.ts/ })[0]!)
    await user.type(screen.getByLabelText(/Review note for/), '   ')
    await user.click(screen.getByRole('button', { name: 'Save note' }))
    expect(onLineComment).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Cancel note' }))
    expect(screen.queryByLabelText(/Review note for/)).not.toBeInTheDocument()
  })
})
