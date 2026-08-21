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
