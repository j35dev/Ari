import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Tooltip } from './Tooltip'

function Harness() {
  return (
    <Tooltip content="Copy to clipboard">
      <button>Copy</button>
    </Tooltip>
  )
}

describe('Tooltip', () => {
  it('appears on keyboard focus and links itself via aria-describedby', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.tab()

    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Copy to clipboard')
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveAttribute(
      'aria-describedby',
      tooltip.id,
    )
  })

  it('hides on blur', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.tab()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    await user.tab()

    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it('shows only after the hover delay and hides on unhover', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Copy' })

    await user.hover(button)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    await screen.findByRole('tooltip')

    await user.unhover(button)
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it('hides on Escape', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.tab()
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })
})
