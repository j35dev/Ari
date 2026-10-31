import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffSurface } from './DiffSurface'

const diff =
  'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-const old = 1\n+const fresh = 2\n tail'
const props = { diffText: diff, path: 'a.ts', comparisonId: 'a'.repeat(64) }
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-index') ? 24 : 240
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0
      this.dispatchEvent(new Event('scroll'))
    },
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

describe('DiffSurface', () => {
  it('switches split/unified, preserves deletion gutters, and searches with the keyboard', async () => {
    const user = userEvent.setup()
    const { container } = render(<DiffSurface {...props} />)
    expect(screen.getByText('const old = 1')).toBeInTheDocument()
    expect(screen.getByText('Before')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Unified diff' }))
    const deleted = container.querySelector('[data-line-type="del"]')!
    expect(deleted.children[0]?.textContent).toBe('1')
    expect(deleted.children[1]?.textContent).toBe('')
    fireEvent.keyDown(screen.getByRole('region', { name: 'Diff for a.ts' }), {
      key: 'f',
      ctrlKey: true,
    })
    expect(screen.getByRole('searchbox', { name: 'Find in diff' })).toHaveFocus()
    await user.type(screen.getByRole('searchbox'), 'fresh')
    expect(screen.getByRole('status')).toHaveTextContent('1/1')
    await user.click(screen.getByRole('button', { name: 'Wrap lines' }))
    expect(container.querySelector('code')).toHaveClass('whitespace-pre-wrap')
  })

  it('selects old-side ranges with context and resets selection for a new revision', async () => {
    const user = userEvent.setup()
    const onRange = vi.fn()
    const { container, rerender } = render(<DiffSurface {...props} onRange={onRange} />)
    await user.click(screen.getByRole('button', { name: 'Select old line 1' }))
    await user.keyboard('{Shift>}')
    await user.click(screen.getByRole('button', { name: 'Select old line 2' }))
    await user.keyboard('{/Shift}')
    expect(onRange).toHaveBeenLastCalledWith({
      side: 'old',
      startLine: 1,
      endLine: 2,
      context: 'const old = 1\ntail',
    })
    rerender(<DiffSurface {...props} comparisonId={'b'.repeat(64)} onRange={onRange} />)
    expect(container.querySelector('.ring-inset')).toBeNull()
  })

  it('discloses whitespace filtering and keeps a raw-patch fallback', async () => {
    const user = userEvent.setup()
    render(
      <DiffSurface
        {...props}
        diffText={diff
          .replace('const old = 1', 'const x = 1')
          .replace('const fresh = 2', 'const x=1')}
      />,
    )
    await user.click(screen.getByRole('checkbox', { name: 'Ignore whitespace' }))
    expect(screen.getByText(/whitespace filtered/)).toBeInTheDocument()
    expect(screen.queryByText('const x = 1')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Raw patch' }))
    expect(screen.getByText(/diff --git a\/a.ts/)).toBeInTheDocument()
  })

  it('mounts only a bounded window of a ten-thousand-line file', () => {
    const text = `--- /dev/null\n+++ b/large.txt\n@@ -0,0 +1,10000 @@\n${Array.from({ length: 10000 }, (_, index) => `+line ${index}`).join('\n')}`
    const { container } = render(<DiffSurface {...props} path="large.txt" diffText={text} />)
    expect(container.querySelectorAll('[data-index]').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-index]').length).toBeLessThan(50)
    expect(screen.queryByText('line 9999')).not.toBeInTheDocument()
  })

  it('shows explicit binary and empty-content states', () => {
    const { rerender } = render(
      <DiffSurface
        {...props}
        diffText={'diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ'}
      />,
    )
    expect(screen.getByText(/Binary content changed/)).toBeInTheDocument()
    rerender(<DiffSurface {...props} diffText="" />)
    expect(screen.getByText('No text changes in this selection.')).toBeInTheDocument()
  })
})
