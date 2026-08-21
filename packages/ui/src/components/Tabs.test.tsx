import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tabs } from './Tabs'

afterEach(cleanup)

function renderDemo(overrides?: { onValueChange?: (value: string) => void }) {
  return render(
    <Tabs defaultValue="one" onValueChange={overrides?.onValueChange}>
      <Tabs.List aria-label="Demo">
        <Tabs.Tab value="one">One</Tabs.Tab>
        <Tabs.Tab value="two">Two</Tabs.Tab>
        <Tabs.Tab value="three">Three</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="one">Content one</Tabs.Panel>
      <Tabs.Panel value="two">Content two</Tabs.Panel>
      <Tabs.Panel value="three">Content three</Tabs.Panel>
    </Tabs>,
  )
}

describe('Tabs', () => {
  it('moves focus and selection with arrow keys (automatic activation)', async () => {
    const user = userEvent.setup()
    renderDemo()
    const one = screen.getByRole('tab', { name: 'One' })
    const two = screen.getByRole('tab', { name: 'Two' })
    one.focus()
    await user.keyboard('{ArrowRight}')
    expect(two).toHaveFocus()
    expect(two).toHaveAttribute('aria-selected', 'true')
    expect(one).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByText('Content two')).toBeVisible()
    expect(screen.getByText('Content one')).not.toBeVisible()
  })

  it('wraps at the edges and supports Home/End', async () => {
    const user = userEvent.setup()
    renderDemo()
    const one = screen.getByRole('tab', { name: 'One' })
    const three = screen.getByRole('tab', { name: 'Three' })
    one.focus()
    await user.keyboard('{End}')
    expect(three).toHaveFocus()
    expect(three).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowRight}')
    expect(one).toHaveFocus()
    expect(one).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    expect(one).toHaveFocus()
  })

  it('associates tabs and panels via aria-controls/id', () => {
    renderDemo()
    const one = screen.getByRole('tab', { name: 'One' })
    const panel = screen.getByRole('tabpanel', { name: 'One' })
    expect(one).toHaveAttribute('aria-controls', panel.id)
    expect(panel).toHaveAttribute('aria-labelledby', one.id)
    const threeControls = screen
      .getByRole('tab', { name: 'Three' })
      .getAttribute('aria-controls')
    const threePanel = threeControls
      ? document.getElementById(threeControls)
      : null
    expect(threePanel).not.toBeNull()
    expect(threePanel).not.toBeVisible()
  })

  it('selects on click and reports onValueChange', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    renderDemo({ onValueChange })
    await user.click(screen.getByRole('tab', { name: 'Two' }))
    expect(onValueChange).toHaveBeenCalledWith('two')
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('renders the animated indicator only on the active tab', () => {
    renderDemo()
    const one = screen.getByRole('tab', { name: 'One' })
    const two = screen.getByRole('tab', { name: 'Two' })
    expect(one.querySelector('[data-indicator]')).not.toBeNull()
    expect(two.querySelector('[data-indicator]')).toBeNull()
  })

  it('defers to the controlled value', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const { rerender } = render(
      <Tabs value="one" onValueChange={onValueChange}>
        <Tabs.List aria-label="Demo">
          <Tabs.Tab value="one">One</Tabs.Tab>
          <Tabs.Tab value="two">Two</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="one">Content one</Tabs.Panel>
        <Tabs.Panel value="two">Content two</Tabs.Panel>
      </Tabs>,
    )
    await user.click(screen.getByRole('tab', { name: 'Two' }))
    expect(onValueChange).toHaveBeenCalledWith('two')
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    rerender(
      <Tabs value="two" onValueChange={onValueChange}>
        <Tabs.List aria-label="Demo">
          <Tabs.Tab value="one">One</Tabs.Tab>
          <Tabs.Tab value="two">Two</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="one">Content one</Tabs.Panel>
        <Tabs.Panel value="two">Content two</Tabs.Panel>
      </Tabs>,
    )
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })
})
