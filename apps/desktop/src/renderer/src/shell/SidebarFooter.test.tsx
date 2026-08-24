import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Titlebar } from './Titlebar'

describe('Titlebar workspace tools', () => {
  it('places workspace tools in the titlebar, not the session sidebar', () => {
    render(<Titlebar projectLabel="demo" activeTool="files" onSelectTool={() => undefined} />)
    expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeInTheDocument()
    for (const label of ['Changes', 'Files', 'Usage', 'Terminal', 'Settings']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: 'Sessions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reports the chosen tool', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<Titlebar projectLabel="demo" onSelectTool={onSelect} />)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onSelect).toHaveBeenCalledWith('settings')
  })
})
