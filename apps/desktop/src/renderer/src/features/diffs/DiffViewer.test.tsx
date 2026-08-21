import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
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
