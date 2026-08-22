import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'

describe('Composer', () => {
  it('sends trimmed text on click and clears the field', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await user.type(screen.getByLabelText('Message'), '  fix the bug  ')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('fix the bug')
    expect(screen.getByLabelText('Message')).toHaveValue('')
  })

  it('sends on Enter and inserts newline on Shift+Enter', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, 'line one{Shift>}{Enter}{/Shift}line two')
    expect(onSend).not.toHaveBeenCalled()
    await user.type(input, '{Enter}')
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('does not send empty or whitespace-only messages', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await user.type(screen.getByLabelText('Message'), '   ')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows a stop button while running and calls onStop', async () => {
    const user = userEvent.setup()
    const onStop = vi.fn()
    render(<Composer onSend={vi.fn()} onStop={onStop} running />)
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('announces queued messages behind the active turn', () => {
    render(<Composer onSend={vi.fn()} running queued={['a', 'b']} />)
    expect(screen.getByText(/2 queued messages/)).toBeInTheDocument()
  })
})

describe('Composer slash popup', () => {
  it('shows filtered commands while a slash token is typed and commits on Enter', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const onSlashCommand = vi.fn()
    render(<Composer onSend={onSend} onSlashCommand={onSlashCommand} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, '/mo')
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toMatchObject([
      expect.stringContaining('/model'),
      expect.stringContaining('/mode'),
    ])
    await user.type(input, '{Enter}')
    expect(onSlashCommand).toHaveBeenCalledWith('model')
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument()
  })

  it('clears only the slash token mid-text', async () => {
    const user = userEvent.setup()
    const onSlashCommand = vi.fn()
    render(<Composer onSend={vi.fn()} onSlashCommand={onSlashCommand} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, 'run /cle')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.type(input, '{Enter}')
    expect(onSlashCommand).toHaveBeenCalledWith('clear')
    expect(input).toHaveValue('run ')
  })

  it('commits on click', async () => {
    const user = userEvent.setup()
    const onSlashCommand = vi.fn()
    render(<Composer onSend={vi.fn()} onSlashCommand={onSlashCommand} />)
    await user.type(screen.getByLabelText('Message'), '/')
    await user.click(screen.getAllByRole('option')[2]!)
    expect(onSlashCommand).toHaveBeenCalledWith('clear')
  })

  it('closes on Escape and reopens when the token changes', async () => {
    const user = userEvent.setup()
    render(<Composer onSend={vi.fn()} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, '/mo')
    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument()
    await user.type(input, '{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument()
    await user.type(input, 'd')
    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument()
  })

  it('shows nothing for plain text or a glued slash', async () => {
    const user = userEvent.setup()
    render(<Composer onSend={vi.fn()} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, 'hello')
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument()
    await user.type(input, ' abc/')
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument()
  })
})

describe('Composer mention popup', () => {
  const SUGGESTIONS = ['src/app.ts', 'src/main.tsx', 'docs/arch.md']

  it('renders nothing without suggestions even on an @ token', async () => {
    const user = userEvent.setup()
    render(<Composer onSend={vi.fn()} />)
    await user.type(screen.getByLabelText('Message'), '@')
    expect(screen.queryByRole('listbox', { name: 'File mentions' })).not.toBeInTheDocument()
  })

  it('lists matching paths and inserts the chosen one on Enter', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} suggestions={SUGGESTIONS} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, 'fix @ap')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]!.textContent).toContain('src/app.ts')
    await user.type(input, '{Enter}')
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('fix @src/app.ts ')
    expect(screen.queryByRole('listbox', { name: 'File mentions' })).not.toBeInTheDocument()
  })

  it('includes the inserted mention when the message is sent', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} suggestions={SUGGESTIONS} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, '@main')
    await user.type(input, '{Enter}')
    await user.type(input, 'x{Enter}')
    expect(onSend).toHaveBeenCalledWith('@src/main.tsx x')
  })

  it('lists at most 8 paths', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 10 }, (_, i) => `file-${i}.ts`)
    render(<Composer onSend={vi.fn()} suggestions={many} />)
    await user.type(screen.getByLabelText('Message'), '@')
    expect(screen.getAllByRole('option')).toHaveLength(8)
  })
})
