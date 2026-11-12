import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ContextMark } from './ContextMark'

const markOf = (container: HTMLElement) =>
  container.querySelector('[data-context-mark]') as HTMLElement

describe('ContextMark', () => {
  it.each(['project', 'unfiled', 'archived'] as const)(
    'exposes its %s variant via data-context-mark',
    (variant) => {
      const { container } = render(<ContextMark variant={variant} />)
      expect(container.querySelector(`[data-context-mark="${variant}"]`)).not.toBeNull()
    },
  )

  it('stays in the shared 18px leading slot (no layout shift)', () => {
    const mark = markOf(render(<ContextMark variant="project" />).container)
    expect(mark.className).toMatch(/size-\[18px\]/)
    expect(mark.className).toMatch(/shrink-0/)
  })

  it('is a line icon with no tile or letter, hidden from assistive tech', () => {
    const mark = markOf(render(<ContextMark variant="project" />).container)
    expect(mark.querySelector('svg')).not.toBeNull()
    expect(mark).toHaveTextContent('')
    expect(mark.className).not.toMatch(/\bbg-/)
    expect(mark).toHaveAttribute('aria-hidden', 'true')
  })

  it('opens the folder while the project is expanded', () => {
    const closed = markOf(render(<ContextMark variant="project" />).container)
    const open = markOf(render(<ContextMark variant="project" open />).container)
    expect(closed).not.toHaveAttribute('data-open')
    expect(open).toHaveAttribute('data-open')
    expect(open.querySelector('svg')?.innerHTML).not.toBe(closed.querySelector('svg')?.innerHTML)
  })

  it('gives projects, Unfiled and the archive different marks', () => {
    const drawing = (variant: 'project' | 'unfiled' | 'archived') =>
      markOf(render(<ContextMark variant={variant} />).container).querySelector('svg')?.innerHTML
    expect(new Set([drawing('project'), drawing('unfiled'), drawing('archived')]).size).toBe(3)
    // Only a project has an open state.
    const shelf = markOf(render(<ContextMark variant="archived" open />).container)
    expect(shelf).not.toHaveAttribute('data-open')
  })

  it('renders neutral by default and has no data-active', () => {
    const mark = markOf(render(<ContextMark variant="project" />).container)
    expect(mark).not.toHaveAttribute('data-active')
    expect(mark.className).toMatch(/text-fg-subtle/)
    expect(mark.className).not.toMatch(/text-accent/)
  })

  it('lifts its ink, never to the accent, when active', () => {
    const mark = markOf(render(<ContextMark variant="project" active />).container)
    expect(mark).toHaveAttribute('data-active')
    expect(mark.className).toMatch(/text-fg-muted/)
    expect(mark.className).not.toMatch(/text-fg-subtle/)
    expect(mark.className).not.toMatch(/text-accent/)
  })
})
