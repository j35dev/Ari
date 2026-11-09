import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Visualization } from './Visualization'

const graph = {
  type: 'graph',
  title: 'Branching flow',
  nodes: [
    { id: 'start', label: 'Start', shape: 'start' },
    { id: 'left', label: 'Review', shape: 'decision', description: 'Check the proposed change.' },
    { id: 'right', label: 'Build' },
    { id: 'end', label: 'Ship', shape: 'end' },
  ],
  edges: [
    { from: 'start', to: 'left', label: 'Check' },
    { from: 'start', to: 'right' },
    { from: 'left', to: 'end' },
    { from: 'right', to: 'end' },
  ],
}

describe('interactive graph navigation', () => {
  it('moves focus spatially and adapts navigation when direction changes', () => {
    render(<Visualization source={JSON.stringify(graph)} />)
    const start = screen.getByRole('img', { name: 'Start' })
    const review = screen.getByRole('img', { name: 'Review: Check the proposed change.' })
    const build = screen.getByRole('img', { name: 'Build' })
    act(() => start.focus())
    fireEvent.keyDown(start, { key: 'ArrowRight' })
    expect(review).toHaveFocus()
    fireEvent.keyDown(review, { key: 'ArrowDown' })
    expect(build).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Vertical' }))
    act(() => start.focus())
    fireEvent.keyDown(start, { key: 'ArrowDown' })
    expect(review).toHaveFocus()
    fireEvent.keyDown(review, { key: 'ArrowRight' })
    expect(build).toHaveFocus()
  })

  it('keeps pinned node details while inspecting connected marks', async () => {
    render(<Visualization source={JSON.stringify(graph)} />)
    const review = screen.getByRole('img', { name: 'Review: Check the proposed change.' })
    fireEvent.click(review)
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Pinned')
    expect(tooltip).toHaveTextContent('Incoming connections1')
    expect(tooltip).toHaveTextContent('Outgoing connections1')
    fireEvent.pointerDown(tooltip)
    expect(screen.getByRole('tooltip')).toBe(tooltip)
    fireEvent.keyDown(review, { key: 'ArrowRight' })
    expect(screen.getByRole('img', { name: 'Ship' })).toHaveFocus()
    expect(tooltip).toHaveTextContent('Check the proposed change.')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
