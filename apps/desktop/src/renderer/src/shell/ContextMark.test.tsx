import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ContextMark } from './ContextMark'

describe('ContextMark', () => {
  it.each(['project', 'unfiled', 'archived'] as const)(
    'exposes its %s variant via data-context-mark',
    (variant) => {
      const { container } = render(<ContextMark variant={variant} />)
      expect(container.querySelector(`[data-context-mark="${variant}"]`)).not.toBeNull()
    },
  )

  it('stays in the shared 20px leading slot (no layout shift)', () => {
    const { container } = render(<ContextMark variant="project" />)
    const mark = container.querySelector('[data-context-mark]') as HTMLElement
    expect(mark.className).toMatch(/size-5/)
    expect(mark.className).toMatch(/shrink-0/)
  })

  it('renders neutral by default and has no data-active', () => {
    const { container } = render(<ContextMark variant="project" />)
    const mark = container.querySelector('[data-context-mark]') as HTMLElement
    expect(mark).not.toHaveAttribute('data-active')
    expect(mark.className).toMatch(/text-fg-subtle/)
    expect(mark.className).not.toMatch(/text-accent/)
  })

  it('fills with the theme accent when active', () => {
    const { container } = render(<ContextMark variant="project" active />)
    const mark = container.querySelector('[data-context-mark]') as HTMLElement
    expect(mark).toHaveAttribute('data-active')
    expect(mark.className).toMatch(/text-accent/)
  })

  it('uses a dashed outline for the unfiled variant only while inactive', () => {
    const { container: idle } = render(<ContextMark variant="unfiled" />)
    const path = idle.querySelector('path') as SVGPathElement
    expect(path.getAttribute('stroke-dasharray')).not.toBeNull()

    const { container: active } = render(<ContextMark variant="unfiled" active />)
    const activePath = active.querySelector('path') as SVGPathElement
    expect(activePath.getAttribute('stroke-dasharray')).toBeNull()
    expect(activePath.getAttribute('fill')).toBe('currentColor')
  })
})
