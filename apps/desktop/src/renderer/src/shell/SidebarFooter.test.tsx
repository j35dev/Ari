import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SidebarFooter } from './Sidebar'

describe('SidebarFooter', () => {
  it('places workspace tools in the sidebar strip', () => {
    render(<SidebarFooter active="session" onSelect={() => undefined} />)
    expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeInTheDocument()
    for (const label of ['Sessions', 'Changes', 'Files', 'Usage', 'Terminal', 'Settings']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    // Projects are sidebar groups now, not a strip destination (M16).
    expect(screen.queryByRole('button', { name: 'Projects' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reports the chosen tool', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<SidebarFooter active={null} onSelect={onSelect} />)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onSelect).toHaveBeenCalledWith('settings')
  })
})
