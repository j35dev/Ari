import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Project } from '@ari/contracts/project'
import { TerminalProjectPicker } from './TerminalProjectPicker'

const projects: Project[] = [
  {
    id: 'main',
    name: 'Ari',
    path: 'D:\\Projects\\Ari',
    colorIndex: 0,
    createdAt: 0,
    lastOpenedAt: 0,
    open: true,
    status: 'ok',
  },
  {
    id: 'worktree',
    name: 'Ari',
    path: 'D:\\Projects\\Ari-worktree',
    colorIndex: 1,
    createdAt: 0,
    lastOpenedAt: 0,
    open: true,
    status: 'ok',
  },
  {
    id: 'mobile',
    name: 'Mobile',
    path: 'D:\\Projects\\Mobile',
    colorIndex: 2,
    createdAt: 0,
    lastOpenedAt: 0,
    open: true,
    status: 'missing',
  },
]

function Harness({ changed, add = vi.fn() }: { changed: (id: string) => void; add?: () => void }) {
  const [value, setValue] = useState<string | null>('main')
  return (
    <TerminalProjectPicker
      projects={projects}
      value={value}
      onChange={(id) => {
        setValue(id)
        changed(id)
      }}
      onAddProject={add}
    />
  )
}

describe('TerminalProjectPicker', () => {
  it('distinguishes same-name projects by folder and selects their actual IDs', async () => {
    const user = userEvent.setup()
    const changed = vi.fn()
    render(<Harness changed={changed} />)
    await user.click(screen.getByRole('button', { name: 'Terminal project' }))
    expect(screen.getByRole('listbox', { name: 'Terminal projects' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Ari · D:/Projects/Ari' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await user.click(screen.getByRole('option', { name: 'Ari · D:/Projects/Ari-worktree' }))
    expect(changed).toHaveBeenCalledWith('worktree')
    expect(screen.getByRole('button', { name: 'Terminal project' })).toHaveAttribute(
      'title',
      'Ari · D:\\Projects\\Ari-worktree',
    )
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })

  it('searches folder paths and supports keyboard selection and Escape focus restoration', async () => {
    const user = userEvent.setup()
    const changed = vi.fn()
    render(<Harness changed={changed} />)
    const trigger = screen.getByRole('button', { name: 'Terminal project' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    const search = screen.getByRole('textbox', { name: 'Find terminal project' })
    await waitFor(() => expect(search).toHaveFocus())
    await user.type(search, '\\Mobile')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText('Folder unavailable')).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(changed).toHaveBeenCalledWith('mobile')
    await user.click(trigger)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('keeps Add project available when there are no matches', async () => {
    const user = userEvent.setup()
    const add = vi.fn()
    render(<Harness changed={vi.fn()} add={add} />)
    await user.click(screen.getByRole('button', { name: 'Terminal project' }))
    await user.type(screen.getByRole('textbox', { name: 'Find terminal project' }), 'unknown')
    expect(screen.getByText('No matching projects.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    expect(add).toHaveBeenCalledOnce()
  })
})
