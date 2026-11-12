import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SidebarFooter } from './SidebarFooter'

vi.mock('../features/focus', () => ({
  FocusPill: () => <span>focus</span>,
}))

describe('SidebarFooter', () => {
  it('holds the app destinations: usage and settings', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SidebarFooter onSelectTool={onSelect} />)

    await user.click(screen.getByRole('button', { name: 'Usage' }))
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onSelect.mock.calls).toEqual([['usage'], ['settings']])
  })

  it('marks the destination that is open', () => {
    render(<SidebarFooter activeTool="usage" onSelectTool={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Usage' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('carries the focus tools, and leaves live provider usage to the titlebar', () => {
    render(<SidebarFooter onSelectTool={() => undefined} />)
    expect(screen.getByText('focus')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /usage:/ })).not.toBeInTheDocument()
  })
})
