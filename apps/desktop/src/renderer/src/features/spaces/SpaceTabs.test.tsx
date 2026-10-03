import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { initialLayout } from '../split/split-layout'
import { SpaceTabs, type SpaceTabsProps } from './SpaceTabs'
import type { Space } from './spaces'

function space(id: string, name: string): Space {
  return { id, name, layout: initialLayout(() => `pane-${id}`) }
}

function setup(overrides: Partial<SpaceTabsProps> = {}): SpaceTabsProps {
  const props: SpaceTabsProps = {
    spaces: [space('a', 'Alpha'), space('b', 'Beta')],
    activeSpaceId: 'a',
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onClose: vi.fn(),
    onRename: vi.fn(),
    onReorder: vi.fn(),
    canCreate: true,
    ...overrides,
  }
  render(<SpaceTabs {...props} />)
  return props
}

describe('SpaceTabs', () => {
  it('renders one tab per space and marks the active one', () => {
    setup()

    const alpha = screen.getByRole('tab', { name: 'Alpha' })
    const beta = screen.getByRole('tab', { name: 'Beta' })
    expect(alpha).toHaveAttribute('aria-selected', 'true')
    expect(beta).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tablist', { name: 'Spaces' })).toBeInTheDocument()
  })

  it('selects a tab on click', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('tab', { name: 'Beta' }))
    expect(props.onSelect).toHaveBeenCalledWith('b')
  })

  it('creates a new space from the trailing button', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('button', { name: 'New space' }))
    expect(props.onCreate).toHaveBeenCalledTimes(1)
  })

  it('disables the new-space button at the ceiling', () => {
    setup({ canCreate: false })
    expect(screen.getByRole('button', { name: 'New space' })).toBeDisabled()
  })

  it('closes a tab without also selecting it', () => {
    const props = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Close Beta' }))
    expect(props.onClose).toHaveBeenCalledWith('b')
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('hides the close affordance while there is only one space', () => {
    setup({ spaces: [space('a', 'Alpha')], activeSpaceId: 'a' })
    expect(screen.queryByRole('button', { name: 'Close Alpha' })).not.toBeInTheDocument()
  })

  it('renames in place on double-click and Enter', () => {
    const props = setup()
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Alpha' }))

    const input = screen.getByRole('textbox', { name: 'Rename space' })
    fireEvent.change(input, { target: { value: 'Deep work' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onRename).toHaveBeenCalledWith('a', 'Deep work')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('abandons a rename on Escape', () => {
    const props = setup()
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Alpha' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename space' }), { key: 'Escape' })

    expect(props.onRename).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: 'Alpha' })).toBeInTheDocument()
  })

  it('moves selection with the arrow keys', () => {
    const props = setup()
    const alpha = screen.getByRole('tab', { name: 'Alpha' })
    alpha.focus()
    fireEvent.keyDown(alpha, { key: 'ArrowRight' })
    expect(props.onSelect).toHaveBeenCalledWith('b')
  })

  it('removes a tab when its space disappears', () => {
    const props: SpaceTabsProps = {
      spaces: [space('a', 'Alpha'), space('b', 'Beta')],
      activeSpaceId: 'a',
      onSelect: vi.fn(),
      onCreate: vi.fn(),
      onClose: vi.fn(),
      onRename: vi.fn(),
      onReorder: vi.fn(),
      canCreate: true,
    }
    const { rerender } = render(<SpaceTabs {...props} />)
    expect(screen.getByRole('tab', { name: 'Beta' })).toBeInTheDocument()

    rerender(<SpaceTabs {...props} spaces={[space('a', 'Alpha')]} />)
    expect(screen.queryByRole('tab', { name: 'Beta' })).not.toBeInTheDocument()
  })

  it('names the activity state in the tab title', () => {
    setup({ statusOf: (target) => (target.id === 'b' ? 'working' : null) })
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('title', 'Beta — working')
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('title', 'Alpha')
  })

  it('renames from the tab context menu', () => {
    const props = setup()
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Beta' }), { clientX: 40, clientY: 20 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }))

    const input = screen.getByRole('textbox', { name: 'Rename space' })
    expect(input).toHaveValue('Beta')
    fireEvent.change(input, { target: { value: 'Side project' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onRename).toHaveBeenCalledWith('b', 'Side project')
  })

  it('reorders from the tab context menu', () => {
    const props = setup()
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Alpha' }), { clientX: 40, clientY: 20 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move right' }))
    expect(props.onReorder).toHaveBeenCalledWith('a', null)

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Beta' }), { clientX: 40, clientY: 20 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move left' }))
    expect(props.onReorder).toHaveBeenCalledWith('b', 'a')
  })

  it('opens the active tab for rename with F2', () => {
    setup()
    const alpha = screen.getByRole('tab', { name: 'Alpha' })
    alpha.focus()
    fireEvent.keyDown(alpha, { key: 'F2' })

    expect(screen.getByRole('textbox', { name: 'Rename space' })).toHaveValue('Alpha')
  })
})
